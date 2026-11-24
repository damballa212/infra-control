import type { Action, Operation } from './types.js';
import type { SecretRequest, SecretGrant, SecretAuditEvent } from './secrets.js';
export type PageInfo={nextCursor:string|null;hasMore:boolean};
export type OperationReview={
  disposition:'pending'|'reviewed'|'superseded';version:number;canonicalResourceId:string;updatedAt:string;reason:string;
  supersededByOperationId?:string;reviewedBy?:string;reviewedAt?:string;
  evidence:{kind:'execution_result'|'later_confirmed_power'|'human_review';operationId?:string;action?:Action;confirmedAt?:string};
};
export type OperationPageResponse={operations:Operation[]}&PageInfo;
export type IncidentSourceContext={
  eventIds:number[];resourceId?:string;catalogId?:string;scopeKey?:string;conflict?:true;
};
export type OperationalIncident={
  id:string;key:string;component:string;resourceId:string|null;canonicalResourceId:string|null;connectionId?:string;scopeKey?:string;
  accountId?:string;account?:string;budgetName?:string;sourceContext?:IncidentSourceContext;
  category:string;kind:'application'|'observability'|'availability'|'coverage'|'budget'|'change';source:string;
  status:'open'|'unknown'|'resolved'|'information';actionable:boolean;openedAt:string;updatedAt:string;resolvedAt?:string;
  openingEventId:number|null;lastEventId:number|null;recoveryEventId?:number;version:number;
  evidence:{reasonCode:string;observedAt:string|null;from?:string;to?:string};
  acknowledgement?:{by:string;at:string;reportVersion:number};
};
export type IncidentPageResponse={incidents:OperationalIncident[]}&PageInfo;
export type ResourceExpectation={resourceId:string;mode:'observe'|'on-demand'|'always-on';version:number;updatedAt:string|null};
export type PowerIntent={operationId:string;action:Action;result:Operation['state'];requestedAt:string;confirmedAt?:string;targetPower:'on'|'off';targetSystem?:'windows'|'cachyos';transition:{expected:boolean;reasonCode?:string;expiresAt:string|null}};
export type AttentionSummary={
  fetchedAt:string;counts:{attentionGroups:number;active:number;pendingReviews:number;openIncidents:number;unknownIncidents:number;coverageProblems:number};
  coverage:{scopes:number;healthy:number;partial:number;failed:number;stale:number};pendingApprovals?:number;
};
export type SecretRequestsPageResponse={requests:SecretRequest[];pendingCount:number}&PageInfo;
export type SecretGrantsPageResponse={grants:SecretGrant[]}&PageInfo;
export type SecretAuditPageResponse={events:SecretAuditEvent[]}&PageInfo;
