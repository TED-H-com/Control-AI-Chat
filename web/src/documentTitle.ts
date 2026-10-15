import { useEffect } from 'react';
import { useDeployment } from './deployment.js';
import { PRODUCT_NAME } from '@shared/brand.js';

export const fallbackBrandName=PRODUCT_NAME;

export function formatDocumentTitle(pageLabel:string|null|undefined,brandName:string|null|undefined):string{
  const brand=brandName?.trim()||fallbackBrandName;
  const page=pageLabel?.trim();
  return !page||page===brand?brand:`${page} · ${brand}`;
}

export function useDocumentTitle(pageLabel:string|null|undefined):void{
  const {brandName}=useDeployment();
  useEffect(()=>{document.title=formatDocumentTitle(pageLabel,brandName)},[brandName,pageLabel]);
}
