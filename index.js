const {onRequest}=require("firebase-functions/v2/https");
const {defineSecret}=require("firebase-functions/params");
const admin=require("firebase-admin");
admin.initializeApp();
const db=admin.firestore(),FV=admin.firestore.FieldValue;
const TOKEN=defineSecret("PEYFLEX_TOKEN");
const BASE="https://client.peyflex.com.ng/api/",D=864e5;

// Same formula as the app: 500/day for 30 days, then 1000/day after an approved upgrade.
function earned(a,now){const s=a.activatedAt.toMillis(),u=a.upgradedAt?a.upgradedAt.toMillis():null,e1=Math.min(s+30*D,u??Infinity,now);
 let e=Math.max(0,e1-s)/D*500;if(u&&now>u)e+=(now-u)/D*1000;return e}

async function px(path,opt={}){
 const r=await fetch(BASE+path,{...opt,headers:{Authorization:"Token "+TOKEN.value(),"Content-Type":"application/json"}});
 let j={};try{j=await r.json()}catch(e){}
 return {ok:r.ok,j};
}
// Field names are normalised in ONE place. If Peyflex names differ, edit these three lines only.
const arr=j=>Array.isArray(j)?j:(j.networks||j.plans||j.data||[]);
const nets=j=>arr(j).map(x=>({id:x.identifier||x.id||x.network_id||x.network||x.code,name:x.name||x.label||x.identifier||x.id}));
const plans=j=>arr(j).map(x=>({code:x.plan_code||x.code||x.id||x.plan,name:x.plan_name||x.name||x.label||x.description||x.plan,amount:+(x.amount||x.price||x.plan_amount||0)}));
const state=j=>{const t=String(j.status||j.Status||j.message||"").toLowerCase();return /success/.test(t)?"success":/pending|process|queue/.test(t)?"pending":"failed"};
const phone=p=>String(p||"").replace(/^\+?234/,"0");

exports.api=onRequest({cors:true,secrets:[TOKEN],timeoutSeconds:60},async(req,res)=>{
 const p=req.path.replace(/\/+$/,"")||"/";
 try{
  if(req.method==="GET"&&p==="/networks"){const r=await px("data/networks/");const n=nets(r.j).filter(x=>x.id);return res.json({ok:r.ok&&n.length>0,networks:n})}
  if(req.method==="GET"&&p==="/plans"){const r=await px("data/plans/?network="+encodeURIComponent(req.query.network||""));const l=plans(r.j).filter(x=>x.code&&x.amount>0);return res.json({ok:r.ok&&l.length>0,plans:l})}
  if(req.method!=="POST"||p!=="/purchase")return res.status(404).json({ok:false,error:"Not found"});

  const b=req.body||{},ref=db.doc("accounts/"+String(b.id||"x").slice(0,64)),snap=await ref.get();
  if(!snap.exists||snap.data().status!=="active")return res.json({ok:false,error:"Account is not active."});
  const a=snap.data();
  if(a.lockedUntil&&a.lockedUntil>Date.now())return res.json({ok:false,error:"Too many wrong PIN attempts. Try again in 15 minutes."});
  if(a.pinHash!==b.pinHash){const f=(a.pinFails||0)+1;await ref.update(f>=5?{pinFails:0,lockedUntil:Date.now()+9e5}:{pinFails:f});return res.json({ok:false,error:"Wrong PIN."})}
  if(a.pinFails)await ref.update({pinFails:0});

  let amount=Math.round(+b.amount),title="",body,path;
  if(b.type==="airtime"){
   if(!(amount>=50&&amount<=50000)||!/^(\+?234|0)\d{10}$/.test(b.phone||""))return res.json({ok:false,error:"Invalid airtime request."});
   title=`Airtime · ${String(b.network).toUpperCase()} ${phone(b.phone)}`;path="airtime/topup/";
   body={network:String(b.network).toLowerCase(),amount,mobile_number:phone(b.phone)};
  }else if(b.type==="data"){
   if(!/^(\+?234|0)\d{10}$/.test(b.phone||""))return res.json({ok:false,error:"Invalid phone number."});
   const r=await px("data/plans/?network="+encodeURIComponent(b.network||"")),pl=plans(r.j).find(x=>x.code===b.plan);
   if(!pl)return res.json({ok:false,error:"That plan is no longer available."});
   amount=Math.round(pl.amount);title=`Data · ${pl.name} ${phone(b.phone)}`;path="data/purchase/";
   body={network:b.network,plan_code:pl.code,mobile_number:phone(b.phone)};
  }else if(b.type==="crypto"){
   if(!(amount>=1000)||!/^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$/.test(b.address||""))return res.json({ok:false,error:"Invalid Bitcoin request."});
   title=`Bitcoin · ${b.address.slice(0,6)}…${b.address.slice(-4)}`;
  }else return res.json({ok:false,error:"Unknown purchase type."});

  // Reserve the money first (atomic), so two quick taps cannot overspend.
  const tx=ref.collection("tx").doc();
  try{await db.runTransaction(async t=>{const s=await t.get(ref),d=s.data();
   if(amount>earned(d,Date.now())-(d.spent||0)+0.01)throw new Error("Amount is more than your balance.");
   t.update(ref,{spent:FV.increment(amount)});t.set(tx,{type:b.type,title,amount,status:"processing",createdAt:FV.serverTimestamp()})})}
  catch(e){return res.json({ok:false,error:e.message})}

  if(b.type==="crypto"){ // No exchange API connected: queued for admin to send manually.
   await tx.update({status:"pending"});
   await db.collection("cryptoQueue").doc(tx.id).set({accountId:ref.id,name:a.name,email:a.email,phone:a.phone,address:b.address,amount,status:"pending",txPath:tx.path,createdAt:FV.serverTimestamp()});
   return res.json({ok:true,status:"pending",message:"Your Bitcoin order was received. It is sent to your wallet after we confirm it. Track it in History."});
  }
  const r=await px(path,{method:"POST",body:JSON.stringify(body)}),st=r.ok?state(r.j):"failed";
  await tx.update({status:st,provider:JSON.stringify(r.j).slice(0,500)});
  if(st==="failed"){await ref.update({spent:FV.increment(-amount)});return res.json({ok:false,error:String(r.j.message||r.j.error||"The provider could not complete this. You were not charged.")})}
  return res.json({ok:true,status:st,message:st==="pending"?"Your order is processing. Check History for the final status.":"Done. "+title+" was sent."});
 }catch(e){console.error(e);return res.status(500).json({ok:false,error:"Server error. Check History before trying again."})}
});
