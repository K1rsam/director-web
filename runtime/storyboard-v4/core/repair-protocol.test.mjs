import test from 'node:test';
import assert from 'node:assert/strict';
import {captureRules,buildRequest} from './core.mjs';
import {parseScript} from './source.mjs';
import {createCoordinator} from '../coordinator.mjs';

test('new requests freeze repaired coordinate, role, feedback and dialogue contracts together',()=>{
 const rules=captureRules();assert.equal(rules.modelCoordinateVersion,'model-coordinates-v4');
 assert.equal(rules.modelProjectionVersion,'production-context-v5');assert.equal(rules.productionFeedbackResultVersion,'production-feedback-result-v2');
 assert.equal(rules.dialogueSourceLinkVersion,'dialogue-source-link-v1');
});
test('native kernel identity exposes actual loaded repaired contracts without a model operation',()=>{
 const service=createCoordinator({dataRoot:'/tmp/director-identity-read-only'}),identity=service.runtimeIdentity();
 assert.equal(identity.pid,process.pid);assert.equal(identity.modelCoordinateVersion,'model-coordinates-v4');
 assert.equal(identity.modelProjectionVersion,'production-context-v5');assert.equal(identity.dialogueSourceLinkVersion,'dialogue-source-link-v1');
});
test('explicit old feedback rules and snapshot remain readable and are never silently upgraded',()=>{
 const rules=captureRules();Object.assign(rules,{productionFeedbackResultVersion:'production-feedback-result-v1',modelCoordinateVersion:'model-coordinates-repair-v3',modelProjectionVersion:'production-context-v4'});delete rules.dialogueSourceLinkVersion;
 const payload={stage:'plan',source:parseScript('甲：走。',{key:'repair-protocol'}),settings:{maxUnits:null},rulesSnapshot:rules,productionSnapshot:{version:'production-feedback-v1',feedbackResultVersion:'production-feedback-result-v1',materials:[],touchesEnding:true,touchesOpening:false}};
 const before=JSON.stringify(payload),request=buildRequest(payload);assert.equal(request.productionSnapshot.feedbackResultVersion,'production-feedback-result-v1');assert.equal(JSON.stringify(payload),before);
 const mismatch=structuredClone(payload);mismatch.productionSnapshot.feedbackResultVersion='production-feedback-result-v2';assert.throws(()=>buildRequest(mismatch),{code:'RULE_SNAPSHOT'});
});
