<script setup lang="ts">
import type { PlatformInfo } from '../platform/types';
import type { AppSettings } from '../settings';
import ToggleSwitch from './ToggleSwitch.vue';

const props = defineProps<{ platformInfo: PlatformInfo; settings: AppSettings }>();

const emit = defineEmits<{
  updateSettings: [changes: Partial<AppSettings>];
}>();

function updateConcurrency(event: Event) {
  emit('updateSettings', { concurrentDownloads: Number((event.target as HTMLSelectElement).value) });
}
</script>

<template>
  <section class="subpage about-page" aria-labelledby="about-heading">
    <div class="subpage-heading about-heading">
      <div>
        <h2 id="about-heading">关于</h2>
        <p>塞壬唱片下载器</p>
      </div>
      <span class="page-stamp">{{ props.platformInfo.appVersion }}</span>
    </div>

    <section class="about-display-panel library-display-panel" aria-labelledby="about-display-heading">
      <div class="library-display-copy">
        <p class="section-label">LIBRARY VIEW</p>
        <h3 id="about-display-heading">整理与显示</h3>
        <span>这些选项会立即保存，并应用到后续下载。</span>
      </div>
      <div class="library-display-options">
        <ToggleSwitch :model-value="props.settings.separateDirectory" label="按专辑文件夹保存音乐" description="桌面版下载时按专辑归档。" class="display-toggle" @update:model-value="emit('updateSettings', { separateDirectory: $event })" />
        <ToggleSwitch :model-value="props.settings.groupByDownload" label="按已下载状态分类显示" description="分开展示已下载和未下载歌曲。" class="display-toggle" @update:model-value="emit('updateSettings', { groupByDownload: $event })" />
        <label class="concurrency-setting">
          <span><strong>同时下载任务</strong><small>可设置 1～3 个，默认同时下载 2 个。</small></span>
          <select name="concurrent-downloads" :value="props.settings.concurrentDownloads" @change="updateConcurrency">
            <option :value="1">1 个</option>
            <option :value="2">2 个</option>
            <option :value="3">3 个</option>
          </select>
        </label>
      </div>
    </section>

    <div class="about-grid">
      <section class="about-card legal-card">
        <h3>版权声明</h3>
        <p>本工具旨在辅助用户下载指定网址 <code>monster-siren.hypergryph.com</code> 的资源，仅供学习和研究使用。本工具不储存资源，也不拥有资源版权。使用本工具下载的任何内容，用户应保护知识产权，不侵犯任何第三方的版权或其他合法权益。</p>
        <h3>免责声明</h3>
        <p>工具提供者不对用户使用本工具造成的任何直接、间接、特殊或后果性损害负责。用户应自行承担使用本工具的风险和后果。</p>
        <h3>版权尊重</h3>
        <p>我们反对任何形式的侵权行为。使用本工具时，请尊重内容创作者的版权，不用于任何商业用途。</p>
        <h3>用户责任</h3>
        <p>用户应确保使用本工具的行为符合当地法律法规。违反法律法规所产生的责任由用户自行承担。</p>
      </section>

      <div class="about-side">
        <section class="about-card">
          <h3>开源协议</h3>
          <p>本工具是非盈利的开源项目，用户可以自由使用、修改和分发，但需遵守法律法规。</p>
          <a href="https://github.com/chenwenda316/monster-siren-download-helper" target="_blank" rel="noreferrer">原版 GitHub 地址 <span>↗</span></a>
          <a href="https://github.com/MXWF0/Siren-Records-Music-Downloader" target="_blank" rel="noreferrer">项目 GitHub 地址 <span>↗</span></a>
        </section>
        <section class="about-card runtime-card">
          <h3>当前环境</h3>
          <dl class="about-facts">
            <div><dt>系统</dt><dd>{{ props.platformInfo.os }}</dd></div>
            <div><dt>架构</dt><dd>{{ props.platformInfo.arch }}</dd></div>
            <div><dt>运行方式</dt><dd>{{ props.platformInfo.runtime }}</dd></div>
            <div><dt>版本</dt><dd>{{ props.platformInfo.appVersion }}</dd></div>
          </dl>
        </section>
      </div>
    </div>
  </section>
</template>
