const levels=new Set(['exact','review','context']);
function short(value,max) {if(typeof value!=='string'||value.length>max)throw new Error('Campo inválido.');return value.replace(/[\p{Cc}\p{Cf}]/gu,'');}
export function validateDetection(value) {
  if(value===undefined) return {version:'none',status:'not_reported',findings:[],coverage:[],filesChecked:0,eventsChecked:0,durationMs:0};
  if(!value||!['completed','partial','not_reported'].includes(value.status)||!Array.isArray(value.findings)||value.findings.length>80||!Array.isArray(value.coverage)||value.coverage.length>80)throw new Error('Relatório inválido.');
  const report={version:short(value.version,32),status:value.status,
    findings:value.findings.map(item=>{if(!item||!levels.has(item.level)||!['file','registry','service','process','event','dns'].includes(item.source))throw new Error('Indício inválido.');return {rule:short(item.rule,80),level:item.level,source:item.source,evidence:short(item.evidence,320)};}),
    coverage:value.coverage.map(item=>short(item,160))};
  for(const key of ['filesChecked','eventsChecked','durationMs']) {if(!Number.isInteger(value[key])||value[key]<0||value[key]>3600000)throw new Error('Contagem inválida.');report[key]=value[key];}
  if(value.status==='not_reported' && report.findings.length)throw new Error('Estado inválido.');
  return report;
}
