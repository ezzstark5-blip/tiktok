export function validateSteam(value) {
  if(value===undefined) return {status:'not_reported',accounts:[]};
  if(!value || !['ok','not_found','unavailable','partial','truncated'].includes(value.status) || !Array.isArray(value.accounts) || value.accounts.length>100) throw new Error('Dados Steam inválidos.');
  const seen=new Set();
  const accounts=value.accounts.map(account=>{
    if(!account || typeof account.steamId!=='string' || !/^[0-9]{17}$/.test(account.steamId) || account.steamId.length!==17 || typeof account.displayName!=='string' || account.displayName.length>80 || seen.has(account.steamId)) throw new Error('Dados Steam inválidos.');
    seen.add(account.steamId);
    return {steamId:account.steamId,displayName:account.displayName.replace(/[\p{Cc}\p{Cf}]/gu,'').trim()};
  });
  if(['not_found','unavailable'].includes(value.status) && accounts.length) throw new Error('Estado Steam incompatível.');
  return {status:value.status,accounts};
}
