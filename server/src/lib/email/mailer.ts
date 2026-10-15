import nodemailer from 'nodemailer';
import type { SmtpConfig } from '../../config.js';

export interface MailMessage { readonly to:string;readonly replyTo?:string;readonly subject:string;readonly text:string; }
export interface Mailer { send(message:MailMessage):Promise<void> }
export interface MailLogger { warn(message:string,details?:Readonly<Record<string,unknown>>):void }

export function smtpTransportOptions(smtp:SmtpConfig){return{host:smtp.host,port:smtp.port,secure:smtp.port===465,requireTLS:smtp.port!==465,connectionTimeout:5_000,greetingTimeout:5_000,socketTimeout:10_000,...(smtp.auth?{auth:{user:smtp.auth.user,pass:smtp.auth.pass}}:{})}}

export function createSmtpMailer(smtp:SmtpConfig):Mailer {
  const transport=nodemailer.createTransport(smtpTransportOptions(smtp));
  return{async send(message){await transport.sendMail({from:smtp.from,to:message.to,subject:message.subject,text:message.text,...(message.replyTo?{replyTo:message.replyTo}:{})})}};
}
