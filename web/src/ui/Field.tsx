import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';

export interface FieldBinding {
  id: string;
  describedBy?: string;
  labelledBy?: string;
}

function described(node: ReactNode, id: string): ReactNode {
  if (isValidElement(node)) return cloneElement(node as ReactElement<{id?: string}>, {id});
  return <span id={id}>{node}</span>;
}

function shown(node: ReactNode): boolean {
  return node != null && node !== false && node !== true;
}

/** Label, control, then hint and error. The hint and error stay outside the label and are named by aria-describedby, hint first. */
export function Field({
  className = 'ui-field',
  label,
  hint,
  extraHint,
  error,
  errorFirst = false,
  hintBeforeControl = false,
  hintPlacement = 'stacked',
  labelTag = 'label',
  labelId,
  bare = false,
  children,
}: {
  className?: string;
  label: ReactNode;
  hint?: ReactNode;
  extraHint?: ReactNode;
  error?: ReactNode;
  errorFirst?: boolean;
  hintBeforeControl?: boolean;
  /** `after` keeps the hint a sibling of the field box, so a parent gap stays where it was. */
  hintPlacement?: 'stacked' | 'after';
  labelTag?: 'label' | 'h3';
  labelId?: string;
  bare?: boolean;
  children: (field: FieldBinding) => ReactNode;
}) {
  const uid = useId();
  const controlId = `${uid}-control`;
  const hintId = shown(hint) ? `${uid}-hint` : undefined;
  const extraHintId = shown(extraHint) ? `${uid}-extra` : undefined;
  const errorId = shown(error) ? `${uid}-error` : undefined;
  const describedBy = [hintId, extraHintId, errorId].filter((id): id is string => Boolean(id)).join(' ') || undefined;
  const headingId = labelTag === 'h3' ? (labelId ?? `${uid}-label`) : undefined;
  const hintNode = hintId ? described(hint, hintId) : null;
  const extraNode = extraHintId ? described(extraHint, extraHintId) : null;
  const errorNode = errorId ? described(error, errorId) : null;
  const trailing = errorFirst ? <>{errorNode}{hintNode}{extraNode}</> : <>{hintNode}{extraNode}{errorNode}</>;
  const labelNode = labelTag === 'h3' ? <h3 id={headingId}>{label}</h3> : <label htmlFor={controlId}>{label}</label>;
  const control = children({id: controlId, describedBy, labelledBy: headingId});
  if (hintPlacement === 'after') return <><div className={className}>{labelNode}{control}</div>{trailing}</>;
  const body = <>
    {labelNode}
    {hintBeforeControl ? <>{hintNode}{extraNode}</> : null}
    {control}
    {hintBeforeControl ? errorNode : trailing}
  </>;
  return bare ? body : <div className={className}>{body}</div>;
}
