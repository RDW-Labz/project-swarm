// SPDX-License-Identifier: Apache-2.0
const KNOWN_KEYS=['autoMergeToStageBranch','humanApprovals','changeOrderOverUsd','budgetUsd'];
const HUMAN_KINDS=['scope','contracts','design-gallery','final-stage-pr'];
export const DEFAULT_APPROVAL=Object.freeze({autoMergeToStageBranch:true,humanApprovals:Object.freeze([...HUMAN_KINDS]),changeOrderOverUsd:20,budgetUsd:null});
const isNum=(x)=>typeof x==='number'&&Number.isFinite(x);
const defaults=()=>({...DEFAULT_APPROVAL,humanApprovals:[...DEFAULT_APPROVAL.humanApprovals]});

export function validateApprovalPolicy(raw){
  if(raw===undefined||raw===null) return {policy:Object.freeze(defaults()),errors:[]};
  if(typeof raw!=='object'||Array.isArray(raw)) return {policy:null,errors:['approval must be an object']};
  const errors=[];
  for(const k of Object.keys(raw)) if(!KNOWN_KEYS.includes(k)) errors.push(`unknown key: ${k}`);
  const policy=defaults();
  if('autoMergeToStageBranch' in raw){
    if(typeof raw.autoMergeToStageBranch==='boolean') policy.autoMergeToStageBranch=raw.autoMergeToStageBranch;
    else errors.push('autoMergeToStageBranch must be a boolean');
  }
  if('humanApprovals' in raw){
    const h=raw.humanApprovals;
    if(!Array.isArray(h)) errors.push('humanApprovals must be an array');
    else{
      const bad=h.filter((x)=>!HUMAN_KINDS.includes(x));
      if(bad.length) errors.push(`unknown humanApprovals: ${bad.join(', ')}`);
      else policy.humanApprovals=[...h];
    }
  }
  if('changeOrderOverUsd' in raw){
    if(isNum(raw.changeOrderOverUsd)&&raw.changeOrderOverUsd>=0) policy.changeOrderOverUsd=raw.changeOrderOverUsd;
    else errors.push('changeOrderOverUsd must be a non-negative number');
  }
  if('budgetUsd' in raw){
    if(raw.budgetUsd===null||(isNum(raw.budgetUsd)&&raw.budgetUsd>0)) policy.budgetUsd=raw.budgetUsd;
    else errors.push('budgetUsd must be null or a positive number');
  }
  return {policy:Object.freeze(policy),errors};
}

export function needsHuman(policy,event){
  if(!policy||!event||typeof event!=='object') return true;
  switch(event.kind){
    case 'scope':
    case 'contracts':
    case 'design-gallery':
    case 'final-stage-pr':
      return policy.humanApprovals.includes(event.kind);
    case 'change-order':
      if(!isNum(event.usd)) return true;
      return event.usd>policy.changeOrderOverUsd;
    case 'merge-to-stage-branch':
      return !(policy.autoMergeToStageBranch===true&&event.testsPassed===true&&event.reviewPassed===true);
    case 'spend':
      if(!isNum(event.usd)) return true;
      return policy.budgetUsd!==null&&event.usd>policy.budgetUsd;
    default:
      return true;
  }
}
