import { GatewayError } from '../gateway/errors'
export interface OllamaUsageData {
  plan?: string; balance?: string
  five_hour?: { used_percent: number; reset_at?: string; reset_text?: string }
  seven_day?: { used_percent: number; reset_at?: string; reset_text?: string }
  models?: Array<{ model: string; window: 'five_hour' | 'seven_day'; requests: number }>
}
interface Node { tag: string; attributes: Record<string,string>; children: Node[]; parent?: Node; ownText: string }
const five = ['session usage','5 hour usage','5-hour usage','5h usage','5 hour limit','5-hour limit']
const seven = ['weekly usage','7 day usage','7-day usage','7d usage','weekly limit','7 day limit']
const text = (node: Node): string => [node.ownText, ...node.children.map(text)].join(' ').replace(/\s+/g,' ').trim()
const all = (node: Node): Node[] => [node, ...node.children.flatMap(all)]
function decode(value: string): string { return value.replace(/&(?:#(x[0-9a-f]+|[0-9]+)|([a-z]+));/gi, (match, numeric: string, name: string) => { if(numeric){const code=numeric[0].toLowerCase()==='x'?parseInt(numeric.slice(1),16):Number(numeric);return code>=0&&code<=0x10ffff?String.fromCodePoint(code):''}return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '} as Record<string,string>)[name]??match }) }
/** Narrow bounded DOM reader: usage extraction never executes markup or stores the page. */
function document(html: string): Node {
  const root: Node={tag:'root',attributes:{},children:[],ownText:''},stack=[root]
  let count=0
  const source=html.replace(/<!--[^]*?-->/g,'').replace(/<(script|style)\b[^>]*>[^]*?<\/\1\s*>/gi,'')
  for(const token of source.matchAll(/<[^>]+>|[^<]+/g)){
    const value=token[0]
    if(value.startsWith('</')){const tag=/^<\/\s*([\w-]+)/.exec(value)?.[1].toLowerCase();for(let i=stack.length-1;i>0;i--)if(stack[i].tag===tag){stack.length=i;break}continue}
    if(value.startsWith('<')){
      const tag=/^<\s*([\w-]+)/.exec(value)?.[1].toLowerCase();if(!tag)continue
      if(++count>20000||stack.length>128)throw new Error('invalid_html')
      const attributes: Record<string,string>=Object.create(null)
      for(const match of value.slice(value.indexOf(tag)+tag.length).matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))attributes[match[1].toLowerCase()]=decode(match[2]??match[3]??match[4]??'')
      const parent=stack[stack.length-1],node:Node={tag,attributes,children:[],ownText:'',parent};parent.children.push(node)
      if(!['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'].includes(tag)&&!value.endsWith('/>'))stack.push(node)
    }else stack[stack.length-1].ownText+=' '+decode(value)
  }
  return root
}
export function parseOllamaUsageHTML(html: string): OllamaUsageData {
  const root=document(html),nodes=all(root),page=text(root)
  if(/sign in to ollama|log in to ollama|continue to sign in/i.test(page))throw new GatewayError(401,'ollama_unauthorized','Ollama session has expired')
  const label=(aliases:string[])=>nodes.filter(node=>aliases.some(alias=>{const value=text(node).toLowerCase();return value===alias||value.startsWith(alias+' ')||value.startsWith(alias+':')})).sort((a,b)=>text(a).length-text(b).length)[0]
  const beside=(aliases:string[])=>{const node=label(aliases);if(!node)return undefined;const sibling=node.parent?.children[(node.parent.children.indexOf(node))+1];if(sibling){const value=text(sibling);if(value&&value.length<=80&&value.toLowerCase()!=='manage')return value}for(let p=node.parent,depth=0;p&&depth<4;p=p.parent,depth++){const value=text(p);if(value.length>80)continue;const clean=aliases.reduce((value,alias)=>value.replace(new RegExp(alias,'i'),''),value).replace(/^[:|\s-]+|[:|\s-]+$/g,'');if(clean&&clean.toLowerCase()!=='manage')return clean}return undefined}
  const window=(aliases:string[])=>{
    let candidate: OllamaUsageData['five_hour']
    for(let node=label(aliases),depth=0;node&&depth<6;node=node.parent!,depth++){
      const value=text(node);if(value.length>600)break
      const match=/([0-9]+(?:\.[0-9]+)?)\s*%/.exec(value)
      let percent=match?Number(match[1]):NaN
      if(!Number.isFinite(percent)){
        const tracks=all(node).filter(item=>'data-usage-track' in item.attributes)
        if(tracks.length){const values=all(tracks[0]).map(item=>/(?:^|;)\s*width\s*:\s*([0-9.]+)%/i.exec(item.attributes.style??'')?.[1]).filter(value=>value!==undefined);if(values.length)percent=values.reduce((sum,value)=>sum+Number(value),0)}
      }
      if(!Number.isFinite(percent)||percent<0||percent>100)continue
      if(/remaining/i.test(value)&&!/used/i.test(value))percent=100-percent
      const result: NonNullable<OllamaUsageData['five_hour']>={used_percent:percent}
      const timed=all(node).find(item=>item.attributes.datetime||item.attributes['data-time']);const date=timed?.attributes.datetime??timed?.attributes['data-time'];if(date&&Number.isFinite(Date.parse(date)))result.reset_at=new Date(date).toISOString()
      const reset=/\breset(?:s|ting)?\s*(?:at|in|on)?\s*[:\-]?\s*(.+)/i.exec(value)?.[1];if(reset)result.reset_text=reset.slice(0,256)
      candidate??=result;if(result.reset_at||result.reset_text)return result
    }
    return candidate
  }
  const data:OllamaUsageData={plan:beside(['cloud usage'])??beside(['plan','subscription']),balance:beside(['balance remaining']),five_hour:window(five),seven_day:window(seven)}
  if(!data.balance)data.balance=/(?:balance|credits?)(?:\s+[a-z]+){0,4}\s*[:\n]?\s*((?:USD\s*)?\$?\s*-?[0-9][0-9,]*(?:\.[0-9]{1,4})?)/i.exec(page)?.[1]?.replace(/\s/g,'')
  const models:NonNullable<OllamaUsageData['models']>=[],seen=new Set<string>()
  for(const node of nodes){const model=node.attributes['data-model'],requests=Number((node.attributes['data-requests']??'invalid').replace(/,/g,''));if(!model||model.length>128||!Number.isSafeInteger(requests)||requests<0)continue
    for(let parent=node.parent;parent;parent=parent.parent){const value=(text(parent)+' '+(parent.attributes['data-usage-window']??'').replace(/_/g,' ')).toLowerCase();const f=five.some(alias=>value.includes(alias))||/five hour|5 hour|session/.test(value),s=seven.some(alias=>value.includes(alias))||/seven day|7 day|weekly/.test(value);if(f===s)continue;const scope=f?'five_hour':'seven_day',key=model+':'+scope;if(!seen.has(key)){models.push({model,window:scope,requests});seen.add(key)}break}
  }
  if(models.length)data.models=models.sort((a,b)=>a.window.localeCompare(b.window)||a.model.localeCompare(b.model))
  if(!Object.values(data).some(value=>value!==undefined))throw new Error('unrecognized_html')
  return Object.fromEntries(Object.entries(data).filter(([,value])=>value!==undefined)) as OllamaUsageData
}
