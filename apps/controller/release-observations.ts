import { createHash } from 'node:crypto';
import type { Connection, ExternalResource, Project, ReleaseObservation, Run } from '../../packages/domain/index.js';
import type { DocumentKind, Store } from '../../packages/storage/index.js';

function versions(resource: ExternalResource): Array<{versionId:string;version:string;published:boolean}> {
  const data=resource.data;
  if(resource.provider==='google-play') {
    if(data.track!=='production'||!Array.isArray(data.versionCodes))return [];
    return data.versionCodes.filter(id=>/^\d+$/.test(String(id))).map(id=>({versionId:String(id),version:String(id),published:resource.status==='RELEASE_LIFECYCLE_STATE_PUBLISHED'}));
  }
  if(resource.provider==='app-store') {
    const id=String(data.appStoreVersionId??resource.externalId);
    return [{versionId:id,version:String(data.versionString??id),published:['READY_FOR_SALE','READY_FOR_DISTRIBUTION'].includes(resource.status)}];
  }
  if(resource.provider==='steam')return [{versionId:resource.externalId,version:resource.externalId,published:['live:public','live:default'].includes(resource.status)}];
  return [];
}

/** Baseline the first inventory, then preserve each version's first public transition. */
export function observeReleases(store:Store,run:Run,connection:Connection,resources:ExternalResource[],summary:Record<string,unknown>,at:string):Array<{kind:DocumentKind;id:string;value:unknown}> {
  const updates:Array<{kind:DocumentKind;id:string;value:unknown}>=[];
  const inventory=['list-releases','sync-app','sync'].includes(run.kind)&&!(connection.provider==='google-play'&&run.input.track&&run.input.track!=='production');
  const projects=store.list<Project>('project');
  const scoped=new Set(resources.filter(r=>r.kind==='release'&&r.projectId).map(r=>r.projectId!));
  if(run.projectId)scoped.add(run.projectId);
  if(summary.packageName)for(const project of projects)if((project.storeApps?.['google-play']?.appId??project.appIdentifier)===summary.packageName)scoped.add(project.id);
  const baseline=(projectId:string)=>'release-baseline:'+connection.id+':'+projectId;
  for(const resource of resources) {
    if(resource.kind!=='release'||!resource.projectId)continue;
    const project=projects.find(p=>p.id===resource.projectId);if(!project)continue;
    const app=String(project.storeApps?.[connection.provider as 'google-play'|'app-store'|'steam']?.appId??resource.data.packageName??resource.data.bundleId??resource.data.appId??project.appIdentifier??'');
    if(!app)continue;
    for(const version of versions(resource)) {
      // A Play promotion may retain older version codes that were not requested.
      if(run.kind==='promote-release'&&Array.isArray(resource.data.requestedVersionCodes)&&!resource.data.requestedVersionCodes.map(String).includes(version.versionId))continue;
      const id=createHash('sha256').update([connection.provider,app,version.versionId].join(':')).digest('hex');
      const previous=store.get<ReleaseObservation>('release-observation',id);
      if(previous?.published)continue;
      const explicitlyPublished=run.projectId===resource.projectId&&(['set-live','promote-release','release-version'].includes(run.kind)||(run.kind==='upload-build'&&connection.provider==='google-play'&&String(summary.versionCode)===version.versionId));
      const announce=version.published&&(!!previous||!!store.get('settings',baseline(resource.projectId))||explicitlyPublished);
      const value:ReleaseObservation={id,projectId:resource.projectId,connectionId:connection.id,provider:connection.provider,version:version.version,published:version.published,publishedAt:announce?at:null};
      updates.push({kind:'release-observation',id,value});
    }
  }
  if(inventory)for(const projectId of scoped)updates.push({kind:'settings',id:baseline(projectId),value:{at}});
  return updates;
}
