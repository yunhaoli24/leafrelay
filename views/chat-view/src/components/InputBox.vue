<script setup lang="ts">
    import { ref, type Ref, onMounted, computed, inject, onUnmounted } from 'vue';
    import type { VscodeTextarea } from '@vscode-elements/elements/dist/vscode-textarea/index.js';
    import { sendMessage } from '../utils';

    const props = defineProps<{
        context?: string,
        placeholder?: string,
    }>();
    defineExpose({
        insertText,
    });

    const activeInputBox = inject('activeInputBox');
    const textAreaRef = ref<VscodeTextarea>();
    const placeholder = computed(() => {
        return props.placeholder || 'Send a message to your collaborators...';
    })

    onMounted(() => {
        if (!textAreaRef.value) { return; }
        const textAreaElement = textAreaRef.value.wrappedElement;
        // adjust the style of the text area
        textAreaElement.style.borderRadius = '4px';
        textAreaElement.style.overflow = 'hidden';
    });

    onUnmounted(() => {
        (activeInputBox as Ref<any>).value = ref(undefined);
    });

    function setActive() {
        (activeInputBox as Ref<any>).value = ref({
            'insertText': insertText
        });
    }

    function insertText(text: string) {
        if (!textAreaRef.value) { return; }
        const textAreaElement = textAreaRef.value.wrappedElement;
        const selectionStart = textAreaElement.selectionStart;
        const selectionEnd = textAreaElement.selectionEnd;
        const value = textAreaElement.value;
        const newValue = value.slice(0, selectionStart) + text + value.slice(selectionEnd);
        textAreaElement.value = newValue;
        textAreaElement.selectionStart = selectionStart + text.length;
        textAreaElement.selectionEnd = selectionStart + text.length;
        autoExpand();
        setTimeout(() => {
            textAreaElement.focus();
        }, 0);
    }

    function autoExpand() {
        if (!textAreaRef.value) { return; }
        const textAreaElement = textAreaRef.value.wrappedElement;
        // reset height to 0 so that it can shrink
        textAreaElement.style.height = 'auto';
        textAreaElement.style.height = textAreaElement.scrollHeight + 'px';
    };

    function handleKeybinding(event: KeyboardEvent) {
        const textAreaElement = textAreaRef.value?.wrappedElement;
        if (!textAreaElement) { return; }
        if (event.key==='Enter' && !event.shiftKey && !event.ctrlKey) {
            event.preventDefault();
            sendMessage(textAreaElement.value, props.context);
            textAreaElement.value = '';
            autoExpand();
        } else if (event.key==='Enter' && (event.ctrlKey || event.shiftKey)) {
            event.preventDefault();
            textAreaElement.value += '\n';
            autoExpand();
        }
    }
</script>

<template>
    <vscode-textarea
    ref="textAreaRef"
    @focus="setActive"
    @input="autoExpand"
    @keydown="handleKeybinding"
    autofocus resize="none" :placeholder="placeholder">
    </vscode-textarea>
</template>

<style scoped>
    vscode-textarea {
        width: 100%;
        margin-bottom: 10px;
    }
</style>
