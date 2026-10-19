/**
 * Staggered launch queue.
 *
 * Workers started at the same moment all fire their first LLM request within
 * a couple of seconds of each other — a burst that can saturate a shared GPU
 * (or a provider's rate limit). This queue serializes worker starts and keeps
 * at least `staggerMs` between consecutive starts, with one exemption: when
 * the queue has been idle longer than the stagger, the next start is
 * immediate (a lone spawn is never delayed).
 *
 * The queue is deliberately tiny, with an injectable clock and delay, so the
 * scheduling is unit-testable without real timers. It is FIFO and single-
 * flight: many enqueues coalesce into one pump loop.
 */

export interface QueueItem {
	/** Unique id (worker name) — diagnostics only. */
	id: string;
}

export interface LaunchQueueOptions<T extends QueueItem> {
	/** Minimum gap between consecutive worker starts, ms. 0 = no stagger. */
	staggerMs?: number;
	/** Start one worker. Errors thrown here are swallowed by the queue —
	 *  the callback is responsible for reporting failures (member state,
	 *  lead notification) so the pump can keep going with the next item. */
	start: (item: T) => Promise<void>;
	/** Injectable clock (default Date.now). */
	now?: () => number;
	/** Injectable delay (default setTimeout). */
	delay?: (ms: number) => Promise<void>;
}

export class LaunchQueue<T extends QueueItem = QueueItem> {
	/** Live-tunable: the lead re-reads config and keeps this in sync. */
	staggerMs: number;
	private queue: T[] = [];
	private pumping = false;
	private lastStartAt = 0;
	private readonly start: (item: T) => Promise<void>;
	private readonly now: () => number;
	private readonly delay: (ms: number) => Promise<void>;

	constructor(opts: LaunchQueueOptions<T>) {
		this.staggerMs = Math.max(0, opts.staggerMs ?? 0);
		this.start = opts.start;
		this.now = opts.now ?? Date.now;
		this.delay = opts.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	}

	/** Number of items still waiting to start (excludes the one currently
	 *  starting, if any). */
	get pending(): number {
		return this.queue.length;
	}

	/** Enqueue an item (FIFO). The pump starts automatically. */
	enq(item: T): void {
		this.queue.push(item);
		void this.pump();
	}

	/** Drop all pending items (used on lead shutdown). */
	drain(): void {
		this.queue.length = 0;
	}

	/** How long the next start will wait, in ms (0 when it can start now). */
	nextStartDelayMs(): number {
		if (this.queue.length === 0) return 0;
		return Math.max(0, this.lastStartAt + this.staggerMs - this.now());
	}

	private async pump(): Promise<void> {
		if (this.pumping) return;
		this.pumping = true;
		try {
			for (;;) {
				const item = this.queue.shift();
				if (!item) return;
				// Keep at least staggerMs since the previous start — unless
				// the queue sat idle longer than the stagger, in which case
				// the wait is already satisfied and the start is immediate.
				const wait = Math.max(0, this.lastStartAt + this.staggerMs - this.now());
				if (wait > 0) await this.delay(wait);
				this.lastStartAt = this.now();
				try {
					await this.start(item);
				} catch {
					// The start callback reports its own failures; the queue
					// must never die because of one bad worker.
				}
			}
		} finally {
			this.pumping = false;
		}
	}
}
