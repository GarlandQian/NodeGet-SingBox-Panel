<script setup>
import { onBeforeUnmount, onMounted } from "vue";
import { useSingboxPanel } from "@/composables/useSingboxPanel";
import NodeSidebar from "@/components/NodeSidebar.vue";
import TopTabs from "@/components/TopTabs.vue";
import InboundBar from "@/components/InboundBar.vue";
import ProtocolPicker from "@/components/ProtocolPicker.vue";
import DeployForm from "@/components/DeployForm.vue";
import ActionBar from "@/components/ActionBar.vue";
import BatchProgress from "@/components/BatchProgress.vue";
import RealityScanner from "@/components/RealityScanner.vue";
import UriPanel from "@/components/UriPanel.vue";
import LogPanel from "@/components/LogPanel.vue";

const {
  theme,
  activeTab,
  selectInbound,
  watchNode,
  attachWindowListeners,
  refreshNodes,
  refreshState,
  selectedUuid,
  abortInFlight,
  closeClient,
} = useSingboxPanel();

watchNode();

let detachWindow;

onMounted(async () => {
  selectInbound(null);
  detachWindow = attachWindowListeners();
  await refreshNodes();
  if (selectedUuid.value) await refreshState();
});

onBeforeUnmount(() => {
  detachWindow?.();
  abortInFlight();
  closeClient();
});
</script>

<template>
  <div class="shell" :data-theme="theme">
    <div class="layout">
      <NodeSidebar />
      <main class="workspace">
        <TopTabs />
        <div class="tab-content">
          <div v-if="activeTab === 'inbound'" class="tab-pane">
            <InboundBar />
            <div class="config-card">
              <ProtocolPicker />
              <DeployForm>
                <template #actions>
                  <ActionBar />
                </template>
              </DeployForm>
            </div>
            <BatchProgress />
          </div>

          <RealityScanner v-else-if="activeTab === 'reality'" />
          <UriPanel v-else-if="activeTab === 'export'" />
          <LogPanel v-else-if="activeTab === 'logs'" />
        </div>
      </main>
    </div>
  </div>
</template>
