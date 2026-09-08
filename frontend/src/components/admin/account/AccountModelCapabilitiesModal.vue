<template>
  <BaseDialog :show="show" :title="t('admin.accounts.modelCapabilities.title')" @close="$emit('close')">
    <div v-if="loading" class="py-8 text-center">{{ t('common.loading') }}</div>
    <div v-else class="max-h-[60vh] space-y-3 overflow-y-auto">
      <div v-for="row in rows" :key="row.model.id" class="rounded-lg border p-3 dark:border-dark-600">
        <div class="mb-2 font-medium">{{ row.model.public_name }}</div>
        <div class="grid grid-cols-2 gap-2 text-sm">
          <label v-for="cap in capabilities" :key="cap" :class="{ 'opacity-50': !applicable(row.model, cap) }"><input v-model="row[cap]" type="checkbox" :disabled="!applicable(row.model, cap)" /> {{ t(`admin.accounts.modelCapabilities.${cap}`) }}</label>
        </div>
        <div class="mt-2 flex justify-end"><button class="btn btn-primary btn-sm" :disabled="saving===row.model.id" @click="save(row)">{{ t('common.save') }}</button></div>
      </div>
    </div>
  </BaseDialog>
</template>
<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseDialog from '@/components/common/BaseDialog.vue'
import { adminAPI } from '@/api/admin'
import { useAppStore } from '@/stores/app'
import type { Account } from '@/types'
import type { WorkerAdminModel } from '@/api/admin/models'
const props=defineProps<{show:boolean;account:Account|null}>();const emit=defineEmits<{close:[];updated:[Account]}>();const {t}=useI18n();const app=useAppStore()
const capabilities=['chat_completions','responses','embeddings','image_generation'] as const
type Row={model:WorkerAdminModel}&Record<typeof capabilities[number],boolean>
const loading=ref(false),saving=ref<string|null>(null),rows=ref<Row[]>([]),current=ref<any>(null)
const applicable=(model:WorkerAdminModel,cap:typeof capabilities[number])=>cap==='embeddings'?model.embeddings:cap==='image_generation'?model.image_generation:model.endpoint==='both'||model.endpoint===cap
const normalize=(row:Row)=>Object.fromEntries(capabilities.map(c=>[c,applicable(row.model,c)&&row[c]]))
async function load(){if(!props.account)return;loading.value=true;try{current.value=await adminAPI.accounts.getById(props.account.id);const existing=new Map((current.value.model_capabilities||[]).map((x:any)=>[String(x.model_id),x]));const models=(await adminAPI.models.list(1,1000)).items.filter((m:any)=>m.enabled&&m.platform===props.account?.platform);rows.value=models.map(model=>{const x:any=existing.get(String(model.id))||{};return{model,...Object.fromEntries(capabilities.map(c=>[c,applicable(model,c)&&Boolean(x[c])]))} as Row})}catch(e:any){app.showError(e?.message||t('admin.accounts.modelCapabilities.loadFailed'))}finally{loading.value=false}}
async function save(row:Row){if(!current.value)return;saving.value=row.model.id;try{current.value=await adminAPI.accounts.setModelCapability(current.value,{model_id:row.model.id,...normalize(row)} as any);emit('updated',current.value);app.showSuccess(t('admin.accounts.modelCapabilities.saved'))}catch(e:any){app.showError(e?.message||t('admin.accounts.modelCapabilities.saveFailed'))}finally{saving.value=null}}
watch(()=>props.show,v=>{if(v)load()})
</script>
