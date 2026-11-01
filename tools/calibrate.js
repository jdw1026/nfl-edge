// Calibrate key-number weights for an NFL margin model:
// pmf(m | mu) ∝ Normal(m; mu, sigma) * w(|m|), m integer.
// Targets: approximate historical frequency of |final margin| in NFL games.
const SIGMA = 13.2;
const rawTargets = {0:0.002,1:0.050,2:0.040,3:0.150,4:0.056,5:0.033,6:0.064,7:0.090,8:0.040,9:0.024,10:0.058,11:0.032,12:0.022,13:0.030,14:0.044,15:0.018,16:0.024,17:0.029,18:0.022};
const MAXM = 70;
const scale = 1;
const targets = Object.fromEntries(Object.entries(rawTargets).map(([k,v])=>[k,v*scale]));
function normpdf(x, mu, s){ return Math.exp(-0.5*((x-mu)/s)**2); }
// Typical distribution of closing spreads (abs), roughly.
const muDist = [];
for (let mu = 0; mu <= 14; mu += 0.5) muDist.push({mu, wt: Math.exp(-mu/5)});
let w = {}; for (let k=0;k<=18;k++) w[k]=1;
function modelAbsFreq(w){
  const freq = {}; let totWt=0;
  for (const {mu, wt} of muDist){
    let pm = [], Z=0;
    for (let m=-MAXM;m<=MAXM;m++){ const v = normpdf(m,mu,SIGMA)*(w[Math.abs(m)]??1); pm.push(v); Z+=v; }
    for (let m=-MAXM;m<=MAXM;m++){ const a=Math.abs(m); freq[a]=(freq[a]||0)+wt*pm[m+MAXM]/Z; }
    totWt+=wt;
  }
  for (const k in freq) freq[k]/=totWt;
  return freq;
}
for (let it=0; it<60; it++){
  const f = modelAbsFreq(w);
  for (const k in targets){ w[k] *= targets[k]/f[k]; }
}
const f = modelAbsFreq(w);
console.log('weights:', JSON.stringify(Object.fromEntries(Object.entries(w).map(([k,v])=>[k,+v.toFixed(3)]))));
console.log('check |m| freq:', Object.entries(targets).map(([k,t])=>`${k}:${(f[k]*100).toFixed(1)}/${(t*100).toFixed(1)}`).join(' '));
let tail=0; for (const k in f) if (+k>18) tail+=f[k]; console.log('tail>18:', (tail*100).toFixed(1)+'%');
