export interface LatestRequestHandlers<T> {
  success:(value:T)=>void;
  error:(cause:unknown)=>void;
  settled:()=>void;
}
export interface LatestRequestRunner {
  run:<T>(request:()=>Promise<T>,handlers:LatestRequestHandlers<T>)=>Promise<void>;
  invalidate:()=>void;
}

/** Lets only the newest request update component state, including error and loading state. */
export function createLatestRequestRunner():LatestRequestRunner {
  let revision=0;
  const run=async <T>(request:()=>Promise<T>,handlers:LatestRequestHandlers<T>):Promise<void>=>{
    const ownRevision=++revision;
    try{
      const value=await request();
      if(ownRevision===revision)handlers.success(value);
    }catch(cause){
      if(ownRevision===revision)handlers.error(cause);
    }finally{
      if(ownRevision===revision)handlers.settled();
    }
  };
  return {run,invalidate:()=>{revision+=1;}};
}
