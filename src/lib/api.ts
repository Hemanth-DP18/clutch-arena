const base = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

type ApiResponse<T> = { data:T };
async function request<T>(method:string,path:string,body?:unknown,extraHeaders?:Record<string,string>):Promise<ApiResponse<T>> {
  const response=await fetch(base+path,{
    method,
    headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(extraHeaders||{})},
    body:body===undefined?undefined:JSON.stringify(body)
  });
  const text=await response.text();
  let data:any={};
  try { data=text?JSON.parse(text):{}; } catch { data={error:text||'Unexpected server response'}; }
  if(!response.ok) {
    const err:any=new Error(data?.error||`Request failed (${response.status})`);
    err.response={status:response.status,data};
    throw err;
  }
  return {data};
}
export const api={
  get:<T=any>(path:string,headers?:Record<string,string>)=>request<T>('GET',path,undefined,headers),
  post:<T=any>(path:string,body?:unknown)=>request<T>('POST',path,body),
  put:<T=any>(path:string,body?:unknown)=>request<T>('PUT',path,body),
  delete:<T=any>(path:string,body?:unknown)=>request<T>('DELETE',path,body)
};
