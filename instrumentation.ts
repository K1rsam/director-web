export async function register(){
 if(process.env.NEXT_RUNTIME==='nodejs'){
  const {restoreAuthorizedParallelProduction}=await import('./lib/production-workflow');
  await restoreAuthorizedParallelProduction().catch(()=>console.warn('连续制作恢复尚未完成；请在工作台核对原队列，未另建任务。'));
 }
}
