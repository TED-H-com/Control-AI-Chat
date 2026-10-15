export type MutationMethod='POST'|'PATCH'|'PUT'|'DELETE';
export type MutationSender=<T>(path:string,method:MutationMethod,body?:unknown,version?:number,idempotencyKey?:string)=>Promise<T>;
export type MutationWrite=<T>(path:string,method:MutationMethod,body?:unknown,version?:number)=>Promise<T>;

export function createStableWrite(send:MutationSender,factory:()=>string=()=>crypto.randomUUID()):MutationWrite {
  const keys=new Map<string,string>();
  async function write<T>(path:string,method:MutationMethod,body?:unknown,version?:number):Promise<T> {
    const signature=`${method} ${path}\u0000${version??''}\u0000${JSON.stringify(body??null)}`;
    let key=keys.get(signature);
    if(key===undefined){key=factory();keys.set(signature,key)}
    const result=await send<T>(path,method,body,version,key);
    keys.delete(signature);
    return result;
  }
  return write;
}
