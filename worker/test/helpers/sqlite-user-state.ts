// @ts-expect-error Node SQLite is test-only.
import { DatabaseSync } from 'node:sqlite'
import { UserStateDO } from '../../src/state/user-state-do'
export function sqliteUserStateNamespace(){
 const objects=new Map<string,UserStateDO>(),databases:any[]=[]
 const get=(id:string)=>{let object=objects.get(id);if(!object){const db=new DatabaseSync(':memory:');databases.push(db);let alarm:number|null=null;const storage={sql:{exec:(sql:string,...bindings:unknown[])=>bindings.length||/^(?:SELECT|PRAGMA|WITH)\b/i.test(sql.trimStart())?db.prepare(sql).all(...bindings):(db.exec(sql),[])},transactionSync:<T>(callback:()=>T):T=>{db.exec('BEGIN IMMEDIATE');try{const result=callback();db.exec('COMMIT');return result}catch(error){db.exec('ROLLBACK');throw error}},getAlarm:async()=>alarm,setAlarm:async(time:number|Date)=>{alarm=Number(time)},deleteAlarm:async()=>{alarm=null}};object=new UserStateDO({storage,blockConcurrencyWhile:(callback:()=>Promise<void>)=>callback()} as unknown as DurableObjectState);objects.set(id,object)}return {fetch:(request:Request|string,init?:RequestInit)=>object!.fetch(request instanceof Request?request:new Request(request,init))}}
 return {namespace:{idFromName:(name:string)=>name,get} as unknown as DurableObjectNamespace,get,close:()=>databases.forEach(db=>db.close())}
}
