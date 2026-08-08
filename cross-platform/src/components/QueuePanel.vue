<script setup lang="ts">
import { computed, reactive } from 'vue';
import type { AppSettings } from '../settings';
import type { QueueStore } from '../stores/queue';

const props = defineProps<{ queue: QueueStore; open: boolean; settings: AppSettings }>();
const active = computed(() => props.queue.active.value);
const pending = computed(() => props.queue.pending.value);
const failed = computed(() => props.queue.failed.value);
const completed = computed(() => props.queue.completed.value);
const emit = defineEmits<{ close: []; status: [message: string, tone?: 'normal' | 'success' | 'error'] }>();
const collapsed = reactive({ pending: true, failed: true, completed: true });

function formatBytes(value: number) {
  return `${(value / 1024 / 1024).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function formatEta(seconds: number | null) {
  if (seconds == null) return '正在计算剩余时间';
  if (seconds < 60) return `约 ${seconds} 秒剩余`;
  return `约 ${Math.ceil(seconds / 60)} 分钟剩余`;
}
</script>

<template>
  <Transition name="drawer-fade">
    <div v-if="open" class="queue-layer" @click.self="emit('close')" @keydown.esc="emit('close')">
      <aside class="queue-drawer" role="dialog" aria-modal="true" aria-labelledby="queue-heading">
        <header class="drawer-header">
          <div><h2 id="queue-heading">下载队列</h2><span>并发数量：{{ settings.concurrentDownloads }}</span></div>
          <button type="button" class="drawer-close" aria-label="关闭下载队列" @click="emit('close')">×</button>
        </header>

        <div class="queue-scroll">
          <section class="queue-section active-section">
            <header><span><i class="queue-dot active-dot" aria-hidden="true"></i>当前下载</span><small>{{ active.length }} 项</small></header>
            <div v-if="active.length" class="queue-list">
              <article v-for="item in active" :key="item.id" class="queue-item active-item">
                <div class="queue-item-copy"><strong>{{ item.title }}</strong><span>{{ item.cancelling ? '正在取消下载…' : `${item.album} · ${formatBytes(item.loaded)}${item.total ? ` / ${formatBytes(item.total)}` : ''}` }}</span></div>
                <div class="queue-progress" aria-hidden="true"><span :style="{ width: `${item.progress}%` }"></span></div>
                <button type="button" class="queue-cancel" :disabled="item.cancelling" @click="queue.cancel(item.id)">{{ item.cancelling ? '取消中…' : '取消' }}</button>
                <small>{{ item.total ? `${item.progress}%` : `${(item.rate / 1024 / 1024).toFixed(1)} MB/s` }}</small>
                <em>{{ formatEta(item.etaSeconds) }}</em>
              </article>
            </div>
            <div v-else class="queue-empty">当前没有正在下载的项目</div>
          </section>

          <section class="queue-section">
            <button type="button" class="queue-section-toggle" :aria-expanded="!collapsed.pending" @click="collapsed.pending = !collapsed.pending"><span><i class="queue-dot pending-dot" aria-hidden="true"></i>待下载</span><small>{{ pending.length }} 项 · {{ collapsed.pending ? '展开' : '收起' }}⌄</small></button>
            <div v-if="!collapsed.pending" class="queue-list">
              <article v-for="item in pending" :key="item.id" class="queue-item"><div class="queue-item-copy"><strong>{{ item.title }}</strong><span>{{ item.album }}</span></div><button type="button" class="queue-cancel" @click="queue.cancel(item.id)">取消</button></article>
              <div v-if="!pending.length" class="queue-empty">没有待下载项目</div>
            </div>
          </section>

          <section class="queue-section">
            <button type="button" class="queue-section-toggle" :aria-expanded="!collapsed.failed" @click="collapsed.failed = !collapsed.failed"><span><i class="queue-dot failed-dot" aria-hidden="true"></i>下载失败</span><small>{{ failed.length }} 项 · {{ collapsed.failed ? '展开' : '收起' }}⌄</small></button>
            <div v-if="!collapsed.failed" class="queue-list">
              <article v-for="item in failed" :key="item.id" class="queue-item failed-item"><div class="queue-item-copy"><strong>{{ item.title }}</strong><span>{{ item.message || '下载失败，请重试' }}</span></div><button type="button" class="outline-action" @click="queue.retry(item.id, settings)">重试</button></article>
              <div v-if="!failed.length" class="queue-empty">没有失败项目</div>
            </div>
          </section>

          <section class="queue-section">
            <button type="button" class="queue-section-toggle" :aria-expanded="!collapsed.completed" @click="collapsed.completed = !collapsed.completed"><span><i class="queue-dot downloaded-dot" aria-hidden="true"></i>下载完成</span><small>{{ completed.length }} 项 · {{ collapsed.completed ? '展开' : '收起' }}⌄</small></button>
            <div v-if="!collapsed.completed" class="queue-list">
              <article v-for="item in completed" :key="item.id" class="queue-item completed-item"><div class="queue-item-copy"><strong>{{ item.title }}</strong><span>{{ item.album }}</span></div><small>{{ item.message || '已完成' }}</small></article>
              <div v-if="!completed.length" class="queue-empty">没有完成项目</div>
            </div>
          </section>
        </div>

        <footer class="drawer-footer">
          <button type="button" class="outline-action" @click="queue.togglePaused(settings)">{{ queue.paused.value ? '继续队列' : '暂停队列' }}</button>
          <button v-if="failed.length || completed.length" type="button" class="text-action" @click="queue.clearHistory()">清理历史记录</button>
        </footer>
      </aside>
    </div>
  </Transition>
</template>
