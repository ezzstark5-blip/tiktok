const fields=new Set(['requestId','pin','status','durationMs','matches','steamCount','steamStatus','messageId','code','retry','findingCount','detectionStatus']);
export function log(event, details={}) {
  const clean={time:new Date().toISOString(),event};
  for(const [key,value] of Object.entries(details)) if(fields.has(key)) clean[key]=key==='pin'?`****${String(value).slice(-4)}`:value;
  console.log(JSON.stringify(clean));
}
