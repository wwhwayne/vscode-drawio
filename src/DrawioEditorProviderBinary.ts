import {
	CustomEditorProvider,
	EventEmitter,
	CustomDocument,
	CancellationToken,
	Uri,
	CustomDocumentBackupContext,
	CustomDocumentBackup,
	CustomDocumentOpenContext,
	WebviewPanel,
	CustomDocumentContentChangeEvent,
	workspace,
	commands,
} from "vscode";
import { DrawioDocumentChange, CustomDrawioInstance } from "./DrawioInstance";
import { extname } from "path";
import { DrawioWebviewInitializer } from "./DrawioWebviewInitializer";
import { DrawioEditorManager } from "./DrawioEditorManager";

export class DrawioEditorProviderBinary
	implements CustomEditorProvider<DrawioBinaryDocument> {
	private readonly onDidChangeCustomDocumentEmitter = new EventEmitter<
		CustomDocumentContentChangeEvent<DrawioBinaryDocument>
	>();

	public readonly onDidChangeCustomDocument = this
		.onDidChangeCustomDocumentEmitter.event;

	public constructor(
		private readonly drawioWebviewInitializer: DrawioWebviewInitializer,
		private readonly drawioEditorManager: DrawioEditorManager
	) {}

	public saveCustomDocument(
		document: DrawioBinaryDocument,
		cancellation: CancellationToken
	): Promise<void> {
		return document.save();
	}

	public saveCustomDocumentAs(
		document: DrawioBinaryDocument,
		destination: Uri,
		cancellation: CancellationToken
	): Promise<void> {
		return document.saveAs(destination);
	}

	public revertCustomDocument(
		document: DrawioBinaryDocument,
		cancellation: CancellationToken
	): Promise<void> {
		return document.loadFromDisk();
	}

	public async backupCustomDocument(
		document: DrawioBinaryDocument,
		context: CustomDocumentBackupContext,
		cancellation: CancellationToken
	): Promise<CustomDocumentBackup> {
		return document.backup(context.destination);
	}

	public async openCustomDocument(
		uri: Uri,
		openContext: CustomDocumentOpenContext,
		token: CancellationToken
	): Promise<DrawioBinaryDocument> {
		const document = new DrawioBinaryDocument(uri, openContext.backupId);
		document.onChange(() => {
			this.onDidChangeCustomDocumentEmitter.fire({
				document,
			});
		});
		document.onInstanceSave(() => {
			commands.executeCommand("workbench.action.files.save");
		});

		return document;
	}

	public async resolveCustomEditor(
		document: DrawioBinaryDocument,
		webviewPanel: WebviewPanel,
		token: CancellationToken
	): Promise<void> {
		const drawioInstance = await this.drawioWebviewInitializer.initializeWebview(
			document.uri,
			webviewPanel.webview,
			{ isReadOnly: false }
		);
		this.drawioEditorManager.createDrawioEditor(
			webviewPanel,
			drawioInstance,
			{
				kind: "drawio",
				document,
			}
		);
		document.setDrawioInstance(drawioInstance);
	}
}

export class DrawioBinaryDocument implements CustomDocument {
	private readonly onChangeEmitter = new EventEmitter<DrawioDocumentChange>();
	public readonly onChange = this.onChangeEmitter.event;

	private readonly onInstanceSaveEmitter = new EventEmitter<void>();
	public readonly onInstanceSave = this.onInstanceSaveEmitter.event;

	private _drawio: CustomDrawioInstance | undefined;

	private get drawio(): CustomDrawioInstance {
		return this._drawio!;
	}

	private _isDirty = false;
	public get isDirty() {
		return this._isDirty;
	}

	private currentXml: string | undefined;

	public constructor(
		public readonly uri: Uri,
		public readonly backupId: string | undefined
	) {}

	public setDrawioInstance(instance: CustomDrawioInstance): void {
		if (this._drawio) {
			throw new Error("Instance already set!");
		}
		this._drawio = instance;

		instance.onInit.sub(async () => {
			if (this.currentXml) {
				this.drawio.loadXmlLike(this.currentXml);
			} else if (this.backupId) {
				const backupFile = Uri.parse(this.backupId);
				const content = await workspace.fs.readFile(backupFile);
				const xml = Buffer.from(content).toString("utf-8");
				await this.drawio.loadXmlLike(xml);
				this._isDirty = true; // because of backup
			} else {
				this.loadFromDisk();
			}
		});

		instance.onChange.sub((change) => {
			this.currentXml = change.newXml;
			this._isDirty = true;
			this.onChangeEmitter.fire(change);
		});

		instance.onSave.sub((change) => {
			this.onInstanceSaveEmitter.fire();
		});
	}

	public async loadFromDisk(): Promise<void> {
		this._isDirty = false;
		if (this.uri.fsPath.endsWith(".png")) {
			const buffer = await workspace.fs.readFile(this.uri);
			await this.drawio.loadPngWithEmbeddedXml(buffer);
		} else {
			throw new Error("Invalid file extension");
		}
	}

	public save(): Promise<void> {
		this._isDirty = false;
		return this.saveAs(this.uri);
	}

	public async saveAs(target: Uri): Promise<void> {
		const buffer = await this.drawio.export(extname(target.path));
		await workspace.fs.writeFile(target, buffer);
	}

	public async backup(destination: Uri): Promise<CustomDocumentBackup> {
		const xml = await this.drawio.getXml();
		await workspace.fs.writeFile(destination, Buffer.from(xml, "utf-8"));
		return {
			id: destination.toString(),
			delete: async () => {
				try {
					await workspace.fs.delete(destination);
				} catch {
					// noop
				}
			},
		};
	}

	public dispose(): void {}
}
