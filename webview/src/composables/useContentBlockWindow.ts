import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, type ComputedRef, type Ref } from 'vue';

export const CONTENT_BLOCK_MOUNT_LIMIT = 32;
const OVERSCAN = 4;
const ESTIMATED_BLOCK_HEIGHT = 120;

/** One message's visible content blocks and their immediate reading margin. Bodies stay outside
 * this layout index; changing a part cannot create another copy of the message's completed text. */
export function useContentBlockWindow(input: {
  keys: ComputedRef<readonly string[]>;
  root: Ref<HTMLElement | null>;
  scroller: ComputedRef<HTMLElement | null | undefined>;
}) {
  const start = ref(0);
  const heights = new Map<string, number>();
  const measuredVersion = ref(0);
  const gap = ref(8);
  const elements = new Map<string, HTMLElement>();
  const viewport = shallowRef<HTMLElement | null>(null);
  let observer: ResizeObserver | undefined;
  let frame: number | undefined;
  let mounted = false;
  let disposed = false;
  const positions = computed(() => {
    measuredVersion.value;
    const result = new Float64Array(input.keys.value.length + 1);
    input.keys.value.forEach((key, index) => { result[index + 1] = result[index]! + (heights.get(key) ?? ESTIMATED_BLOCK_HEIGHT) + gap.value; });
    return result;
  });
  const end = computed(() => Math.min(input.keys.value.length, start.value + CONTENT_BLOCK_MOUNT_LIMIT));
  const beforeHeight = computed(() => start.value > 0 ? Math.max(0, positions.value[start.value]! - gap.value) : 0);
  const afterHeight = computed(() => end.value < input.keys.value.length
    ? Math.max(0, positions.value[input.keys.value.length]! - positions.value[end.value]! - gap.value) : 0);

  function captureAnchor(): { key: string; offset: number } | undefined {
    const scroller = viewport.value;
    if (!scroller) return undefined;
    const bounds = scroller.getBoundingClientRect();
    for (const [key, element] of elements) {
      const rect = element.getBoundingClientRect();
      if (rect.bottom > bounds.top && rect.top < bounds.bottom) return { key, offset: rect.top - bounds.top };
    }
    return undefined;
  }
  async function restoreAnchor(anchor: ReturnType<typeof captureAnchor>): Promise<void> {
    if (!anchor) return;
    const scroller = viewport.value;
    await nextTick();
    if (disposed || !scroller || scroller !== viewport.value) return;
    const element = elements.get(anchor.key);
    if (!element) return;
    const offset = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    if (Math.abs(offset - anchor.offset) > 1) scroller.scrollTop += offset - anchor.offset;
  }
  function synchronize(): void {
    frame = undefined;
    const root = input.root.value, scroller = viewport.value;
    if (!root || !scroller || input.keys.value.length <= CONTENT_BLOCK_MOUNT_LIMIT) { start.value = 0; return; }
    const offset = Math.max(0, scroller.getBoundingClientRect().top - root.getBoundingClientRect().top);
    let lower = 0, upper = input.keys.value.length;
    while (lower < upper) {
      const middle = (lower + upper) >>> 1;
      if (positions.value[middle + 1]! <= offset) lower = middle + 1;
      else upper = middle;
    }
    const next = Math.max(0, Math.min(lower - OVERSCAN, input.keys.value.length - CONTENT_BLOCK_MOUNT_LIMIT));
    if (next === start.value) return;
    const anchor = captureAnchor();
    start.value = next;
    void restoreAnchor(anchor);
  }
  function schedule(): void {
    if (!mounted || disposed || frame !== undefined) return;
    frame = requestAnimationFrame(synchronize);
  }
  function bindBlock(key: string, value: unknown): void {
    const prior = elements.get(key);
    if (value === prior) return;
    if (prior) { observer?.unobserve(prior); elements.delete(key); }
    if (typeof HTMLElement === 'undefined' || !(value instanceof HTMLElement)) return;
    elements.set(key, value);
    observer?.observe(value);
  }
  function connectScroller(next: HTMLElement | null | undefined): void {
    if (viewport.value === next) return;
    viewport.value?.removeEventListener('scroll', schedule);
    if (viewport.value) observer?.unobserve(viewport.value);
    viewport.value = next ?? null;
    next?.addEventListener('scroll', schedule, { passive: true });
    if (next) observer?.observe(next);
    schedule();
  }
  watch(input.keys, (keys, previousKeys) => {
    const anchor = captureAnchor();
    const retained = new Set(keys);
    for (const key of heights.keys()) if (!retained.has(key)) heights.delete(key);
    const anchorIndex = anchor ? keys.indexOf(anchor.key) : -1;
    const previousAnchorIndex = anchor ? previousKeys.indexOf(anchor.key) : -1;
    const nextStart = anchorIndex >= 0 && previousAnchorIndex >= 0
      ? start.value + anchorIndex - previousAnchorIndex : start.value;
    start.value = Math.max(0, Math.min(nextStart, Math.max(0, keys.length - CONTENT_BLOCK_MOUNT_LIMIT)));
    void restoreAnchor(anchor);
    schedule();
  });
  watch(input.scroller, next => { if (mounted) connectScroller(next); });
  onMounted(() => {
    mounted = true;
    if (typeof ResizeObserver !== 'undefined') observer = new ResizeObserver(entries => {
      const anchor = captureAnchor();
      let changed = false;
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        const key = element.dataset.contentBlockKey;
        if (!key) continue;
        const height = element.getBoundingClientRect().height;
        if (height > 0 && heights.get(key) !== height) { heights.set(key, height); changed = true; }
      }
      if (changed) { measuredVersion.value += 1; void restoreAnchor(anchor); }
      schedule();
    });
    for (const element of elements.values()) observer?.observe(element);
    if (input.root.value) gap.value = Number.parseFloat(getComputedStyle(input.root.value).rowGap) || 8;
    let scroller = input.scroller.value;
    if (!scroller) {
      let parent = input.root.value?.parentElement;
      while (parent) {
        if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) { scroller = parent; break; }
        parent = parent.parentElement;
      }
    }
    connectScroller(scroller);
    schedule();
  });
  onBeforeUnmount(() => {
    disposed = true;
    if (frame !== undefined) cancelAnimationFrame(frame);
    viewport.value?.removeEventListener('scroll', schedule);
    observer?.disconnect();
    elements.clear(); heights.clear();
  });
  return { start, end, beforeHeight, afterHeight, bindBlock };
}
