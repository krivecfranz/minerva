import { Plugin, ItemView, Notice, requestUrl } from "obsidian";

// ponytail: no settings tab, no styles.css, no manifest icons. One view, done.

const VIEW_TYPE = "minerva-reviews-view";
const CARDS_PATH = "000-Meta/minerva/cards.json";
const SESSIONS_PATH = "000-Meta/minerva/sessions.jsonl";

class MinervaReviewsView extends ItemView {
	constructor(leaf: any) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Minerva Reviews";
	}

	async onOpen() {
		await this.render();
	}

	private async render() {
		const root = this.contentEl;
		root.empty();
		root.createEl("h2", { text: "Minerva Reviews" });

		try {
			const due = await this.readDueCards();
			root.createEl("p", {
				text: `${due.length} card(s) due.`,
			});

			// ponytail: cap at 10, no pagination, no virtualization.
			for (const card of due.slice(0, 10)) {
				const item = root.createDiv();
				item.createSpan({ text: card.question });
				const btn = item.createEl("button", { text: "Reveal answer" });
				btn.addEventListener("click", () => {
					if (btn.textContent === "Reveal answer") {
						item.createDiv({ text: card.answer });
						btn.textContent = "Hide answer";
					} else {
						item.querySelector("div:last-of-type")?.remove();
						btn.textContent = "Reveal answer";
					}
				});
			}

			// ponytail: static hint instead of clipboard/deep-link complexity.
			root.createEl("p", {
				text: 'Run: npm start --review in your minerva folder',
				cls: "mod-muted",
			});

			this.renderSessions(root);
		} catch (e) {
			new Notice(`Minerva Reviews: ${e.message}`);
		}
	}

	private async readDueCards(): Promise<any[]> {
		const file = this.app.vault.getAbstractFileByPath(CARDS_PATH);
		if (!file) throw new Error(`${CARDS_PATH} not found`);
		const raw = await this.app.vault.read(file as any);
		const cards = JSON.parse(raw);
		const now = Date.now();
		return cards.filter((c: any) => new Date(c.fsrs?.due ?? 0).getTime() <= now);
	}

	private async renderSessions(root: HTMLElement) {
		try {
			const file = this.app.vault.getAbstractFileByPath(SESSIONS_PATH);
			if (!file) return; // ponytail: sessions optional, silence is fine.
			const raw = await this.app.vault.read(file as any);
			const lines = raw.trim().split("\n").filter(Boolean).slice(-5);
			root.createEl("h3", { text: "Last sessions" });
			for (const line of lines) {
				try {
					const obj = JSON.parse(line);
					// ponytail: defensive field access, two known shapes.
					const summary = obj.summary ?? obj.data?.summary;
					if (summary) root.createEl("p", { text: String(summary) });
				} catch {
					// ponytail: skip bad lines, don't fail the whole view.
				}
			}
		} catch (e) {
			new Notice(`Minerva Reviews: could not read sessions: ${e.message}`);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

export default class MinervaReviewsPlugin extends Plugin {
	async onload() {
		this.registerView(VIEW_TYPE, (leaf: any) => new MinervaReviewsView(leaf));
		this.addRibbonIcon("list-checks", "Minerva Reviews", () => {
			this.activateView();
		});
	}

	private async activateView() {
		// ponytail: always open a fresh leaf in the right sidebar. No workspace state juggling.
		const { workspace } = this.app;
		workspace.detachLeavesOfType(VIEW_TYPE);
		const leaf = workspace.getRightLeaf(false);
		await leaf.setViewState({ type: VIEW_TYPE, active: true });
		workspace.revealLeaf(leaf);
	}
}

// ponytail: requestUrl imported for future API calls; unused on purpose for now.
void requestUrl;
