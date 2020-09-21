import * as _read from 'read';
import { WebApi, getBasicHandler } from 'azure-devops-node-api/WebApi';
import { IGalleryApi, GalleryApi } from 'azure-devops-node-api/GalleryApi';
import * as denodeify from 'denodeify';
import chalk from 'chalk';
import * as yauzl from 'yauzl';
import { PublicGalleryAPI } from './publicgalleryapi';
import { ISecurityRolesApi } from 'azure-devops-node-api/SecurityRolesApi';

export interface IInMemoryFile {
	path: string;
	readonly contents: Buffer | string;
}

export interface ILocalFile {
	path: string;
	readonly localPath: string;
}

export type IFile = IInMemoryFile | ILocalFile;

export function isInMemoryFile(file: IFile): file is IInMemoryFile {
	return !!(file as IInMemoryFile).contents;
}

const __read = denodeify<_read.Options, string>(_read);
export function read(prompt: string, options: _read.Options = {}): Promise<string> {
	if (process.env['VSCE_TESTS'] || !process.stdout.isTTY) {
		return Promise.resolve('y');
	}

	return __read({ prompt, ...options });
}

const marketplaceUrl = process.env['VSCE_MARKETPLACE_URL'] || 'https://marketplace.visualstudio.com';

export function getPublishedUrl(extension: string): string {
	return `${marketplaceUrl}/items?itemName=${extension}`;
}

export async function getGalleryAPI(pat: string): Promise<IGalleryApi> {
	// from https://github.com/Microsoft/tfs-cli/blob/master/app/exec/extension/default.ts#L287-L292
	const authHandler = getBasicHandler('OAuth', pat);
	return new GalleryApi(marketplaceUrl, [authHandler]);

	// const vsoapi = new WebApi(marketplaceUrl, authHandler);
	// return await vsoapi.getGalleryApi();
}

export async function getSecurityRolesAPI(pat: string): Promise<ISecurityRolesApi> {
	const authHandler = getBasicHandler('OAuth', pat);
	const vsoapi = new WebApi(marketplaceUrl, authHandler);
	return await vsoapi.getSecurityRolesApi();
}

export function getPublicGalleryAPI() {
	return new PublicGalleryAPI(marketplaceUrl, '3.0-preview.1');
}

export function normalize(path: string): string {
	return path.replace(/\\/g, '/');
}

function chain2<A, B>(a: A, b: B[], fn: (a: A, b: B) => Promise<A>, index = 0): Promise<A> {
	if (index >= b.length) {
		return Promise.resolve(a);
	}

	return fn(a, b[index]).then(a => chain2(a, b, fn, index + 1));
}

export function chain<T, P>(initial: T, processors: P[], process: (a: T, b: P) => Promise<T>): Promise<T> {
	return chain2(initial, processors, process);
}

export function flatten<T>(arr: T[][]): T[] {
	return [].concat.apply([], arr) as T[];
}

const CancelledError = 'Cancelled';

export function isCancelledError(error: any) {
	return error === CancelledError;
}

export class CancellationToken {
	private listeners: Function[] = [];
	private _cancelled: boolean = false;
	get isCancelled(): boolean {
		return this._cancelled;
	}

	subscribe(fn: Function): Function {
		this.listeners.push(fn);

		return () => {
			const index = this.listeners.indexOf(fn);

			if (index > -1) {
				this.listeners.splice(index, 1);
			}
		};
	}

	cancel(): void {
		const emit = !this._cancelled;
		this._cancelled = true;

		if (emit) {
			this.listeners.forEach(l => l(CancelledError));
			this.listeners = [];
		}
	}
}

export async function sequence(promiseFactories: { (): Promise<any> }[]): Promise<void> {
	for (const factory of promiseFactories) {
		await factory();
	}
}

enum LogMessageType {
	DONE,
	INFO,
	WARNING,
	ERROR,
}

const LogPrefix = {
	[LogMessageType.DONE]: chalk.bgGreen.black(' DONE '),
	[LogMessageType.INFO]: chalk.bgBlueBright.black(' INFO '),
	[LogMessageType.WARNING]: chalk.bgYellow.black(' WARNING '),
	[LogMessageType.ERROR]: chalk.bgRed.black(' ERROR '),
};

function _log(type: LogMessageType, msg: any, ...args: any[]): void {
	args = [LogPrefix[type], msg, ...args];

	if (type === LogMessageType.WARNING) {
		console.warn(...args);
	} else if (type === LogMessageType.ERROR) {
		console.error(...args);
	} else {
		console.log(...args);
	}
}

export interface LogFn {
	(msg: any, ...args: any[]): void;
}

export const log = {
	done: _log.bind(null, LogMessageType.DONE) as LogFn,
	info: _log.bind(null, LogMessageType.INFO) as LogFn,
	warn: _log.bind(null, LogMessageType.WARNING) as LogFn,
	error: _log.bind(null, LogMessageType.ERROR) as LogFn,
};

export function unzip(
	packagePath: string,
	onFile: (file: IInMemoryFile) => void,
	filter?: (name: string) => boolean
): Promise<void> {
	return new Promise<void>((c, e) => {
		yauzl.open(packagePath, (err, zipfile) => {
			if (err) {
				return e(err);
			}

			const promises: Promise<void>[] = [];
			zipfile.once('end', () => Promise.all(promises).then(() => c()));
			zipfile.on('entry', entry => {
				try {
					if (filter && !filter(entry.fileName)) {
						return;
					}
				} catch (err) {
					return e(err);
				}

				const promise = new Promise<void>((c, e) => {
					zipfile.openReadStream(entry, (err, stream) => {
						if (err) {
							return e(err);
						}

						const buffers = [];
						stream.on('data', buffer => buffers.push(buffer));
						stream.once('error', e);
						stream.once('end', () => {
							try {
								onFile({ path: entry.fileName, contents: Buffer.concat(buffers) });
								c();
							} catch (err) {
								e(err);
							}
						});
					});
				});

				promises.push(promise);
			});
		});
	});
}

export async function unzipAll(packagePath: string, filter?: (name: string) => boolean): Promise<IInMemoryFile[]> {
	const result: IInMemoryFile[] = [];
	await unzip(packagePath, f => result.push(f), filter);
	return result;
}
