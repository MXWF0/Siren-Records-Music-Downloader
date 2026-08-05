<script setup lang="ts">
defineProps<{
  modelValue: boolean;
  label: string;
  description: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
</script>

<template>
  <label class="setting-row">
    <span class="setting-copy">
      <strong>{{ label }}</strong>
      <small>{{ description }}</small>
    </span>
    <input
      class="switch-input"
      type="checkbox"
      :checked="modelValue"
      @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
    />
    <span class="switch-visual" aria-hidden="true"></span>
  </label>
</template>

