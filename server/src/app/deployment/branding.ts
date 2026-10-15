/** Deployment identity shown to users. Branding is public; the maintenance contact is not. */
export interface DeploymentSettingsRow {
  readonly brand_name:string|null;
  readonly brand_icon_file_id:string|null;
  readonly support_vendor_name:string|null;
  readonly support_contact_email:string|null;
  readonly support_contact_phone:string|null;
  readonly support_contact_url:string|null;
  readonly support_notes:string|null;
}
export interface DeploymentSupport {
  readonly vendorName:string|null;readonly email:string|null;readonly phone:string|null;
  readonly url:string|null;readonly notes:string|null;
}
export interface DeploymentBrand {readonly brandName:string|null;readonly brandIconUrl:string|null}

/**
 * The sign-in screen needs the brand before anyone has authenticated, so the name and the icon are
 * served publicly. The maintenance vendor's phone number, address and free-text note are not:
 * they are precisely what a fraudulent support contact would want, and a signed-out
 * visitor has no reason to read them. They are served from an authenticated route instead.
 */
export function deploymentBrand(row:DeploymentSettingsRow|undefined):DeploymentBrand {
  return {brandName:row?.brand_name??null,brandIconUrl:row?.brand_icon_file_id?'/api/v1/deployment/icon':null};
}

export function deploymentSupport(row:DeploymentSettingsRow|undefined):DeploymentSupport|null {
  if(!row)return null;
  const support={vendorName:row.support_vendor_name,email:row.support_contact_email,phone:row.support_contact_phone,
    url:row.support_contact_url,notes:row.support_notes};
  // An enterprise that recorded nothing gets nothing, so the console shows no empty contact card.
  return Object.values(support).some(value=>value!==null&&value!=='')?support:null;
}
