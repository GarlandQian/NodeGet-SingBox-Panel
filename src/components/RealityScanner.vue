<script setup>
import { computed } from "vue";
import { useSingboxPanel } from "@/composables/useSingboxPanel";

const {
  realityForm,
  realityRunning,
  realityError,
  realityResult,
  selectedUuid,
  runRealityScanAction,
  applyRealityCandidate,
} = useSingboxPanel();

const candidates = computed(() => realityResult.value?.candidates || []);

const stats = computed(() => [
  ["目标", realityResult.value?.target_count || "0"],
  ["候选", realityResult.value?.scan_count || String(candidates.value.length)],
  ["端口", realityResult.value?.scan_port || String(realityForm.port)],
  ["校验", realityResult.value?.checked_domains || "0"],
]);

const canRun = computed(
  () =>
    Boolean(
      selectedUuid.value?.trim?.() &&
        realityForm.targets.trim() &&
        !realityRunning.value,
    ),
);
</script>

<template>
  <section class="panel">
    <div class="panel-title-row">
      <div>
        <p class="section-title">Reality 目标筛选</p>
        <p class="section-note">
          输入自有 IP、CIDR、域名或列表，在当前节点上生成候选并做 Reality 适配检查。
        </p>
      </div>
      <button class="button" :disabled="!canRun" @click="runRealityScanAction">
        {{ realityRunning ? "筛选中..." : "开始筛选" }}
      </button>
    </div>

    <div class="reality-grid">
      <label class="field reality-targets">
        <span class="field-label">目标</span>
        <textarea
          v-model="realityForm.targets"
          class="textarea"
          rows="6"
          placeholder="每行一个 IP / CIDR / 域名"
        />
      </label>

      <div class="panel-grid compact-grid">
        <label class="field">
          <span class="field-label">端口</span>
          <input v-model.number="realityForm.port" class="input" type="number" min="1" max="65535" />
        </label>
        <label class="field">
          <span class="field-label">线程</span>
          <input v-model.number="realityForm.threads" class="input" type="number" min="1" max="256" />
        </label>
        <label class="field">
          <span class="field-label">单次超时</span>
          <input v-model.number="realityForm.timeout" class="input" type="number" min="1" max="60" />
        </label>
        <label class="field">
          <span class="field-label">总时长</span>
          <input v-model.number="realityForm.duration" class="input" type="number" min="5" max="1800" />
        </label>
        <label class="field">
          <span class="field-label">显示数量</span>
          <input v-model.number="realityForm.maxResults" class="input" type="number" min="1" max="200" />
        </label>
        <label class="field">
          <span class="field-label">校验数量</span>
          <input v-model.number="realityForm.maxCheckDomains" class="input" type="number" min="1" max="100" />
        </label>
      </div>
    </div>

    <div v-if="realityError" class="empty">{{ realityError }}</div>

    <div v-if="realityResult" class="reality-result">
      <div class="summary compact-summary">
        <div v-for="item in stats" :key="item[0]" class="summary-item">
          <div class="summary-label">{{ item[0] }}</div>
          <div class="summary-value">{{ item[1] }}</div>
        </div>
      </div>

      <div v-if="candidates.length" class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>IP</th>
              <th>Origin</th>
              <th>Cert Domain</th>
              <th>Issuer</th>
              <th>Geo</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="candidate in candidates"
              :key="`${candidate.ip}-${candidate.certDomain}`"
            >
              <td>{{ candidate.ip }}</td>
              <td>{{ candidate.origin }}</td>
              <td>{{ candidate.certDomain }}</td>
              <td>{{ candidate.certIssuer }}</td>
              <td>{{ candidate.geoCode || "-" }}</td>
              <td class="table-action">
                <button class="button small" @click="applyRealityCandidate(candidate)">填入</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="empty">没有得到候选目标。</div>

      <div class="output">
        <p class="section-title">RealityChecker</p>
        <pre class="output-box">{{ realityResult.checkerOutput || "没有校验输出" }}</pre>
      </div>
    </div>
  </section>
</template>
