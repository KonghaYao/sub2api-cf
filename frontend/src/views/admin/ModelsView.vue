<template>
  <AppLayout>
    <div class="space-y-6 p-6">
      <div class="flex items-center justify-between">
        <div><h1 class="text-2xl font-semibold">{{ t('admin.models.title') }}</h1><p class="text-sm text-gray-500">{{ t('admin.models.description') }}</p></div>
        <button class="btn btn-primary" @click="openCreate">{{ t('admin.models.create') }}</button>
      </div>
      <div class="rounded-xl border bg-white p-4 dark:border-dark-600 dark:bg-dark-800">
        <div v-if="loading" class="py-8 text-center">{{ t('admin.models.loading') }}</div>
        <table v-else class="w-full text-sm">
          <thead><tr class="border-b text-left"><th class="p-2">{{ t('admin.models.publicName') }}</th><th>{{ t('admin.models.upstreamName') }}</th><th>{{ t('admin.models.platform') }}</th><th>{{ t('admin.models.endpoint') }}</th><th>{{ t('admin.models.capabilities') }}</th><th>{{ t('admin.models.status') }}</th><th>{{ t('admin.models.actions') }}</th></tr></thead>
          <tbody><tr v-for="model in models" :key="model.id" class="border-b dark:border-dark-600">
            <td class="p-2 font-medium">{{ model.public_name }}</td><td>{{ model.upstream_name }}</td><td>{{ model.platform }}</td><td>{{ model.endpoint }}</td>
            <td><span v-if="model.embeddings" class="mr-2">Embeddings</span><span v-if="model.image_generation">{{ t('admin.models.imageGeneration') }}</span></td>
            <td>{{ t(model.enabled ? 'admin.models.enabled' : 'admin.models.disabled') }}</td>
            <td class="space-x-2"><button class="text-primary-600" @click="openEdit(model)">{{ t('admin.models.edit') }}</button><button v-if="model.enabled" class="text-red-600" @click="disableModel(model)">{{ t('admin.models.disable') }}</button></td>
          </tr></tbody>
        </table>
      </div>
    </div>
    <BaseDialog :show="show" :title="t(editing ? 'admin.models.editTitle' : 'admin.models.createTitle')" @close="show=false">
      <form class="space-y-4" @submit.prevent="save">
        <label class="block"><span class="input-label">{{ t('admin.models.publicName') }}</span><input v-model="form.public_name" required class="input" /></label>
        <label class="block"><span class="input-label">{{ t('admin.models.upstreamName') }}</span><input v-model="form.upstream_name" required class="input" /></label>
        <label class="block"><span class="input-label">{{ t('admin.models.platform') }}</span><select v-model="form.platform" class="input"><option v-for="p in platforms" :key="p">{{ p }}</option></select></label>
        <label class="block"><span class="input-label">Endpoint</span><select v-model="form.endpoint" class="input"><option value="chat_completions">chat_completions</option><option value="responses">responses</option><option value="both">both</option></select></label>
        <div class="flex gap-5"><label><input v-model="form.embeddings" type="checkbox" /> Embeddings</label><label><input v-model="form.image_generation" type="checkbox" /> {{ t('admin.models.imageGeneration') }}</label><label><input v-model="form.enabled" type="checkbox" /> {{ t('admin.models.enabled') }}</label></div>
        <div class="flex justify-end gap-2"><button type="button" class="btn" @click="show=false">{{ t('admin.models.cancel') }}</button><button class="btn btn-primary" :disabled="saving">{{ t('admin.models.save') }}</button></div>
      </form>
    </BaseDialog>
  </AppLayout>
</template>
<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/layout/AppLayout.vue'
import BaseDialog from '@/components/common/BaseDialog.vue'
import { adminAPI } from '@/api/admin'
import { useAppStore } from '@/stores/app'
import type { WorkerAdminModel, WorkerAdminModelInput, WorkerModelPlatform } from '@/api/admin/models'
const { t } = useI18n()
const app=useAppStore(), models=ref<WorkerAdminModel[]>([]), loading=ref(false), saving=ref(false), show=ref(false), editing=ref<WorkerAdminModel|null>(null)
const platforms: WorkerModelPlatform[]=['openai','anthropic','gemini','codex','grok']
const blank=():WorkerAdminModelInput=>({platform:'openai',public_name:'',upstream_name:'',endpoint:'both',embeddings:false,image_generation:false,enabled:true})
const form=reactive<WorkerAdminModelInput>(blank())
async function load(){loading.value=true;try{models.value=(await adminAPI.models.list(1,1000)).items}catch(e:any){app.showError(e?.message||t('admin.models.loadFailed'))}finally{loading.value=false}}
function openCreate(){editing.value=null;Object.assign(form,blank());show.value=true}
function openEdit(m:WorkerAdminModel){editing.value=m;Object.assign(form,m);show.value=true}
async function save(){saving.value=true;try{if(editing.value)await adminAPI.models.update(editing.value,{...form});else await adminAPI.models.create({...form});show.value=false;await load();app.showSuccess(t('admin.models.saved'))}catch(e:any){app.showError(e?.message||t('admin.models.saveFailed'))}finally{saving.value=false}}
async function disableModel(m:WorkerAdminModel){try{await adminAPI.models.disable(m);await load()}catch(e:any){app.showError(e?.message||t('admin.models.disableFailed'))}}
onMounted(load)
</script>
