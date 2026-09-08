// Reject a second turn unless the gateway preserves both calls and their results.
export async function toolRoundtrip(request: { url: string; clone(): { json(): Promise<unknown> } }): Promise<Response | null> {
  let body: any
  try { body = await request.clone().json() } catch { return null }
  if (body?.model !== 'tool-roundtrip-upstream') return null
  const responses = new URL(request.url).pathname === '/v1/responses'
  const source = responses ? body.input : body.messages
  const outputs = source.filter((item: any) => responses ? item.type === 'function_call_output' : item.role === 'tool')
  const calls = responses ? source.filter((item: any) => item.type === 'function_call')
    : source.flatMap((item: any) => item.tool_calls ?? []).map((item: any) => ({call_id:item.id,...item.function}))
  const expected = [{call_id:'call-shanghai',name:'weather',arguments:'{"city":"上海"}'},{call_id:'call-tokyo',name:'weather',arguments:'{"city":"東京"}'}]
  if (outputs.length) {
    const valid = expected.every(call => calls.some((value: any) => value.call_id === call.call_id && value.name === call.name && value.arguments === call.arguments))
      && outputs.length === 2 && outputs.every((item: any) => {
        const id = responses ? item.call_id : item.tool_call_id
        return (responses ? item.output : item.content) === (id === 'call-shanghai' ? '上海：晴' : id === 'call-tokyo' ? '東京：雨' : undefined)
      })
    if (!valid) return Response.json({error:'tool call/result association was not preserved'}, {status:422})
  }
  if (responses) {
    const output = outputs.length ? [{type:'message',role:'assistant',content:[{type:'output_text',text:'上海晴，東京雨。'}]}]
      : expected.map((call, index) => ({type:'function_call',id:'fc-roundtrip-'+index,...call,arguments:call.arguments+call.arguments}))
    return new Response('data: '+JSON.stringify({type:'response.completed',response:{id:'resp-roundtrip-'+outputs.length,status:'completed',model:body.model,output,usage:{input_tokens:6,output_tokens:2}}})+'\n\n', {headers:{'content-type':'text/event-stream'}})
  }
  const message = outputs.length ? {role:'assistant',content:'上海晴，東京雨。'} : {role:'assistant',content:null,tool_calls:expected.map(call=>({id:call.call_id,type:'function',function:{name:call.name,arguments:call.arguments}}))}
  const usage={prompt_tokens:6,completion_tokens:2,total_tokens:8}
  if (body.stream) return new Response('data: '+JSON.stringify({choices:[{index:0,delta:message,finish_reason:'stop'}]})+'\n\ndata: '+JSON.stringify({choices:[],usage})+'\n\ndata: [DONE]\n\n', {headers:{'content-type':'text/event-stream'}})
  return Response.json({id:'chatcmpl-roundtrip',object:'chat.completion',model:body.model,choices:[{index:0,message,finish_reason:outputs.length?'stop':'tool_calls'}],usage})
}
