import { Fragment, type ReactNode } from 'react';
import type { ChatTranslate } from './i18n.js';

const SAFE_PROTOCOLS=new Set(['http:','https:','mailto:','tel:']);
export function safeMarkdownUrl(value:string):string|undefined {
  const url=value.trim();
  if(!url)return undefined;
  // Browsers treat both forms as protocol-relative URLs, not same-origin paths.
  if(url.startsWith('//')||url.startsWith('/\\'))return undefined;
  if(url.startsWith('/')||url.startsWith('./')||url.startsWith('../')||url.startsWith('#'))return url;
  try{return SAFE_PROTOCOLS.has(new URL(url).protocol)?url:undefined}catch{return undefined}
}

function inline(text:string,keyPrefix:string):ReactNode[] {
  const nodes:ReactNode[]=[];
  // Link destinations allow one non-nested pair of parentheses. Keeping this bounded avoids
  // pathological backtracking on long streamed lines.
  const token=/(`+)([^`]*?)\1|(!?)\[([^\]]+)\]\(((?:[^\s()]|\([^\s()]*\))+)(?:\s+["'][^"']*["'])?\)|(\*\*|__)(.+?)\6|(?<!\*)\*([^*\n]+?)\*(?!\*)|(?<!\w)_([^_\n]+?)_(?!\w)/g;
  let at=0,index=0,match:RegExpExecArray|null;
  while((match=token.exec(text))){
    if(match.index>at)nodes.push(text.slice(at,match.index));
    const key=`${keyPrefix}-${index++}`;
    if(match[1])nodes.push(<code key={key}>{match[2]}</code>);
    else if(match[4]){
      // Images are deliberately rendered as their alt text: model-controlled remote image loads can
      // leak a viewer's IP and are outside the chat markdown contract.
      if(match[3])nodes.push(match[4]);
      else {const href=safeMarkdownUrl(match[5]!);nodes.push(href?<a key={key} href={href} rel="noopener noreferrer">{inline(match[4],`${key}-a`)}</a>:match[4]);}
    } else if(match[6])nodes.push(<strong key={key}>{inline(match[7],`${key}-b`)}</strong>);
    else nodes.push(<em key={key}>{inline(match[8]??match[9]??'',`${key}-i`)}</em>);
    at=token.lastIndex;
  }
  if(at<text.length)nodes.push(text.slice(at));
  return nodes;
}

function tableCells(line:string):string[] {
  const trimmed=line.trim().replace(/^\|/,'').replace(/\|$/,'');
  return trimmed.split(/(?<!\\)\|/).map(cell=>cell.trim().replace(/\\\|/g,'|'));
}
const isDivider=(line:string)=>tableCells(line).every(cell=>/^:?-{3,}:?$/.test(cell));

type ListMatch={indent:number;ordered:boolean;content:string};
function listMatch(line:string):ListMatch|undefined {
  const match=line.match(/^(\s*)([-+*]|\d+[.)])\s+(.+)$/);
  if(!match)return undefined;
  return {indent:match[1]!.replace(/\t/g,'    ').length,ordered:/^\d/.test(match[2]!),content:match[3]!};
}

function listBlock(lines:string[],start:number,indent:number,ordered:boolean,keyPrefix:string):{node:ReactNode;next:number} {
  const items:ReactNode[]=[];let i=start;
  while(i<lines.length){
    const item=listMatch(lines[i]!);
    if(!item||item.indent!==indent||item.ordered!==ordered)break;
    const itemKey=`${keyPrefix}-${items.length}`;
    const children:ReactNode[]=[...inline(item.content,`${itemKey}-text`)];i++;
    while(i<lines.length){
      const nested=listMatch(lines[i]!);
      if(!nested||nested.indent<=indent)break;
      const child=listBlock(lines,i,nested.indent,nested.ordered,`${itemKey}-nested`);
      children.push(child.node);i=child.next;
    }
    items.push(<li key={itemKey}>{children}</li>);
  }
  return {node:ordered?<ol key={keyPrefix}>{items}</ol>:<ul key={keyPrefix}>{items}</ul>,next:i};
}

export function MarkdownContent({text,t}:{text:string;t:ChatTranslate}) {
  const lines=text.replace(/\r\n?/g,'\n').split('\n');
  const output:ReactNode[]=[];let i=0,key=0;
  while(i<lines.length){
    const line=lines[i]!;
    const fence=line.match(/^\s*```\s*([^\s`]*)?.*$/);
    if(fence){const code:string[]=[];i++;while(i<lines.length&&!/^\s*```\s*$/.test(lines[i]!))code.push(lines[i++]!);if(i<lines.length)i++;output.push(<pre key={key++} className="ui-code" aria-label={t('chat.message.codeBlock')} data-language={fence[1]||undefined}><code>{code.join('\n')}</code></pre>);continue}
    if(!line.trim()){i++;continue}
    const heading=line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if(heading){const level=heading[1]!.length;const content=inline(heading[2]!.replace(/\s+#+\s*$/,''),`h${key}`);output.push(level===1?<h1 key={key++}>{content}</h1>:level===2?<h2 key={key++}>{content}</h2>:level===3?<h3 key={key++}>{content}</h3>:level===4?<h4 key={key++}>{content}</h4>:level===5?<h5 key={key++}>{content}</h5>:<h6 key={key++}>{content}</h6>);i++;continue}
    if(/^\s{0,3}((\*|-|_)\s*){3,}$/.test(line)){output.push(<hr key={key++}/>);i++;continue}
    if(line.includes('|')&&i+1<lines.length&&isDivider(lines[i+1]!)){
      const headers=tableCells(line),rows:string[][]=[];i+=2;
      while(i<lines.length&&lines[i]!.includes('|')&&lines[i]!.trim())rows.push(tableCells(lines[i++]!));
      output.push(<div className="ui-markdown-table" key={key++}><table><thead><tr>{headers.map((cell,n)=><th key={n}>{inline(cell,`th${key}-${n}`)}</th>)}</tr></thead><tbody>{rows.map((row,r)=><tr key={r}>{headers.map((_,c)=><td key={c}>{inline(row[c]??'',`td${key}-${r}-${c}`)}</td>)}</tr>)}</tbody></table></div>);continue
    }
    const list=listMatch(line);
    if(list&&list.indent<=3){const block=listBlock(lines,i,list.indent,list.ordered,`list${key++}`);output.push(block.node);i=block.next;continue}
    if(/^\s{0,3}>/.test(line)){const quote:string[]=[];while(i<lines.length&&/^\s{0,3}>/.test(lines[i]!))quote.push(lines[i++]!.replace(/^\s{0,3}>\s?/,''));output.push(<blockquote key={key++}>{quote.map((part,n)=><Fragment key={n}>{n>0&&<br/>}{inline(part,`q${key}-${n}`)}</Fragment>)}</blockquote>);continue}
    const paragraph:string[]=[line];i++;while(i<lines.length&&lines[i]!.trim()&&!/^\s*```/.test(lines[i]!)&&!/^\s{0,3}(#{1,6})\s+/.test(lines[i]!)&&!/^\s{0,3}([-+*]|\d+[.)])\s+/.test(lines[i]!)&&!/^\s{0,3}>/.test(lines[i]!)){paragraph.push(lines[i++]!)}
    output.push(<p key={key++}>{paragraph.map((part,n)=><Fragment key={n}>{n>0&&<br/>}{inline(part,`p${key}-${n}`)}</Fragment>)}</p>);
  }
  return <>{output}</>;
}
