import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { PRODUCT_NAME } from '../server/src/shared/brand.ts';
import {productionCspPlugin} from './src/csp.ts';
export default defineConfig({plugins:[react(),{name:'product-name',transformIndexHtml:html=>html.replaceAll('__PRODUCT_NAME__',PRODUCT_NAME)},productionCspPlugin],resolve:{alias:{'@shared':fileURLToPath(new URL('../server/src/shared',import.meta.url)),'@routes':fileURLToPath(new URL('../server/src/routes',import.meta.url))}},server:{port:5173,proxy:{'/api':{target:'http://127.0.0.1:3010',changeOrigin:true}}},build:{outDir:'dist',sourcemap:false}});
