
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { Writable } from 'stream';
import crypto from 'crypto'; // UUID生成用
import { JSDOM } from 'jsdom'; // ReadabilityにDOMを提供
import { Readability } from '@mozilla/readability'; // コンテンツ抽出
import axios, { AxiosInstance } from 'axios'; // HTTPリクエスト
import * as cheerio from 'cheerio'; // HTML解析 (リンク抽出など)
import { QdrantClient } from '@qdrant/js-client-rest'; // Qdrantクライアント
// 直接PointStructを使用せず、型を定義する（インポートパスの問題を回避）
type PointStruct = {
    id: string | number;
    vector: number[];
    payload?: Record<string, any>;
};
// 元の Server クラスを McpServer としてインポート
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
// StdioServerTransport を正しいパスからインポート
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"; // ビルド成功時のパスに戻す
// zod をインポート (スキーマ定義に利用)
import { z } from "zod";
// ListTools/CallTool スキーマを再度インポート
import {
    ListToolsRequestSchema,
    CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import yargs from 'yargs'; // 引数解析
import { hideBin } from 'yargs/helpers';
import PQueue from 'p-queue'; // 非同期処理キュー
import pino, { Logger } from 'pino'; // ロガー
import { pipeline as Pipeline, PipelineType } from '@xenova/transformers'; // Transformers.js の型

// --- 型定義 ---
interface PageInfo {
    url: string;
    title: string;
    content: string;
}

interface Chunk {
    id: string; // UUID
    text: string;
    metadata: ChunkMetadata;
}

interface ChunkMetadata {
    source_url: string;
    source_title: string;
    doc_id: string; // UUID
    chunk_char_start: number;
    text: string; // チャンクテキスト自体もペイロードに含める
}

interface QdrantSearchResult {
    score: number;
    payload: ChunkMetadata | null; // nullの可能性を考慮
    id: string | number; // IDの型は string | number
}

// Transformers.js パイプラインの型 (より具体的に)
type FeatureExtractionPipeline = (texts: string | string[], options?: { pooling?: "none" | "mean" | "cls"; normalize?: boolean }) => Promise<any>; // 出力型はモデル依存のためany

// --- 設定 ---
const DEFAULT_QDRANT_URL = 'http://localhost:6333'; // デフォルトURLを定数化
const DEFAULT_BASE_COLLECTION_NAME = 'docs-collection'; // デフォルト名を定数化
const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2'; // デフォルトモデル名を定数化
const VECTOR_SIZE = 384;
const SEARCH_LIMIT = 5;
const QDRANT_BATCH_SIZE = 10; // バッチサイズをさらに減らす
const DEFAULT_SCRAPE_LIMIT = 300;
const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 50;
const SCRAPE_CONCURRENCY = 3; // 同時実行数を減らす
const USER_AGENT = 'QdrantMCPServerNodeTS/1.0 (+[https://example.com/botinfo](https://example.com/botinfo))';

// --- ロガー設定 (削除) ---
// const logger: Logger = pino.default(...); // ログ出力を削除

// --- Global Settings ---
let isDebugEnabled = false; // Debug flag state

// --- Transformers.js 設定 ---
let embeddingPipeline: FeatureExtractionPipeline; // 宣言はグローバルに残す
// モデルロード処理は main 関数内に移動

// --- Utility function for delay ---
function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
// --- Logging Function ---
function log(level: 'error' | 'warn' | 'info' | 'debug', ...messages: any[]) {
    if (level === 'error') {
        console.error(...messages);
    } else if (level === 'warn') {
        console.warn(...messages);
    } else if (isDebugEnabled) { // Only log info/debug if debug flag is enabled
        if (level === 'info') {
            console.info(...messages);
        } else if (level === 'debug') {
            console.debug(...messages); // Use console.debug for debug level
        }
    }
}

// --- ヘルパー関数 ---

function sanitizeForCollectionName(name: string): string {
    if (!name) return 'default';
    let sanitized = name.replace(/^https?:\/\//, '');
    sanitized = sanitized.replace(/[^a-zA-Z0-9_-]/g, '_');
    sanitized = sanitized.replace(/_+/g, '_');
    sanitized = sanitized.replace(/^_+|_+$/g, '');
    return sanitized.substring(0, 50) || 'default';
}

function generateStableId(inputString: string): string {
    const hash = crypto.createHash('sha1').update(inputString).digest('hex');
    return `${hash.substring(0, 8)}-${hash.substring(8, 12)}-${hash.substring(12, 16)}-${hash.substring(16, 20)}-${hash.substring(20, 32)}`;
}

// --- スクレイパークラス ---
class Scraper {
    private readonly startUrl: string;
    private readonly limit: number;
    private readonly matchPatterns: string[];
    private readonly baseDomain: string;
    private visitedUrls: Set<string> = new Set();
    private queue: PQueue;
    private scrapedCount: number = 0;
    private processedPages: PageInfo[] = [];
    private axiosInstance: AxiosInstance;

    constructor(startUrl: string, limit: number, matchPatterns: string[] = []) {
        this.startUrl = startUrl;
        this.limit = limit;
        this.matchPatterns = matchPatterns;
        try {
            this.baseDomain = new URL(startUrl).hostname;
        } catch (e) {
            log('error', `Invalid start URL: ${startUrl}`);
            throw e;
        }
        this.queue = new PQueue({ concurrency: SCRAPE_CONCURRENCY });
        this.axiosInstance = axios.create({
            headers: { 'User-Agent': USER_AGENT },
            timeout: 30000, // タイムアウトを30秒に延長
            // httpsAgent: new https.Agent({ rejectUnauthorized: false }) // 必要に応じて
        });
    }

    private _normalizeUrl(url: string, baseUrl: string): string | null {
        try {
            const absoluteUrl = new URL(url, baseUrl);
            absoluteUrl.hash = '';
            return absoluteUrl.href;
        } catch (e) {
            log('warn', `Invalid URL encountered: ${url} (Base: ${baseUrl})`);
            return null;
        }
    }

    private _isValidUrl(url: string | null): url is string { // Type predicate
        if (!url || this.visitedUrls.has(url)) {
            return false;
        }
        try {
            const parsed = new URL(url);
            if (parsed.hostname !== this.baseDomain) return false;

            const extensionMatch = parsed.pathname.match(/\.([a-zA-Z0-9]+)$/);
            if (extensionMatch) {
                const ext = extensionMatch[1].toLowerCase();
                const nonHtmlExtensions = ['pdf', 'zip', 'jpg', 'jpeg', 'png', 'gif', 'css', 'js', 'xml', 'rss', 'mp4', 'mov', 'avi', 'webp', 'svg', 'ico'];
                if (nonHtmlExtensions.includes(ext)) return false;
            }

            if (this.matchPatterns && this.matchPatterns.length > 0) {
                const pathToMatch = parsed.pathname || "/";
                if (!this.matchPatterns.some(pattern => pathToMatch.startsWith(pattern.replace(/\*+$/, '')))) {
                    return false;
                }
            }
            return true;
        } catch (e) {
            log('warn', `Error parsing URL for validation: ${url}`);
            return false;
        }
    }

    private async _fetchPage(url: string): Promise<string | null> {
        try {
            const response = await this.axiosInstance.get<string>(url, { responseType: 'text' });
            const contentType = response.headers['content-type'] || '';
            if (!contentType.toLowerCase().includes('text/html')) {
                log('warn', `Skipping non-HTML content at ${url} (Content-Type: ${contentType})`);
                return null;
            }
            return response.data;
        } catch (error) {
            // axios エラーの詳細を出力
            if (axios.isAxiosError(error)) {
                log('error', `Axios error fetching ${url}: ${error.message}`);
                if (error.response) {
                    log('error', `Status: ${error.response.status}`);
                    // log('error', 'Headers:', error.response.headers); // 必要に応じてヘッダーも出力
                    // log('error', 'Data:', error.response.data); // 必要に応じてデータも出力
                } else if (error.request) {
                    log('error', `No response received for request to ${url}.`);
                    // log('error', 'Request config:', error.config); // リクエスト設定を出力
                    // log('error', 'Request details:', error.request); // リクエストオブジェクトの詳細 (環境依存)
                } else {
                    log('error', 'Error setting up request:', error.message);
                }
                // log('error', 'Full Axios error object:', error.toJSON ? error.toJSON() : error); // エラーオブジェクト全体を出力 (循環参照に注意)
            } else {
                 log('error', `Non-Axios error fetching ${url}:`, error); // Axios以外のエラーも詳細出力
            }
            return null;
        }
    }

    private _extractContentAndLinks(htmlContent: string, url: string): { contentInfo: PageInfo; links: string[] } {
        let contentInfo: PageInfo = { url: url, title: "N/A", content: "" };
        let links = new Set<string>();

        try {
            const dom = new JSDOM(htmlContent, { url: url });
            const reader = new Readability(dom.window.document);
            const article = reader.parse();

            if (article?.content) {
                contentInfo.title = article.title || 'N/A';
                const $content = cheerio.load(article.content);
                // Cheerio の text() は非推奨ではないが、型定義が不完全な場合がある
                contentInfo.content = $content('body').text().replace(/\s\s+/g, '\n').trim(); // より良いテキスト抽出

                const $original = cheerio.load(htmlContent);
                $original('a[href]').each((i, el) => {
                    const href = $original(el).attr('href');
                    if (href) {
                        const normalizedUrl = this._normalizeUrl(href, url);
                        if (this._isValidUrl(normalizedUrl)) {
                            links.add(normalizedUrl);
                        }
                    }
                });
            } else {
                 log('warn', `Readability could not parse content from ${url}`);
                 const $original = cheerio.load(htmlContent);
                 contentInfo.title = $original('title').first().text().trim() || 'N/A';
                 $original('a[href]').each((i, el) => {
                     const href = $original(el).attr('href');
                     if (href) {
                         const normalizedUrl = this._normalizeUrl(href, url);
                         if (this._isValidUrl(normalizedUrl)) {
                             links.add(normalizedUrl);
                         }
                     }
                 });
            }
        } catch (e: any) {
            log('error', `Error extracting content/links from ${url}: ${e.message}`);
             try {
                const $original = cheerio.load(htmlContent);
                contentInfo.title = $original('title').first().text().trim() || 'N/A';
             } catch {}
        }

        return { contentInfo, links: Array.from(links) };
    }

    private _enqueueScrape(url: string): void {
        // 有効なURLとキュー制限をチェック
        if (!this._isValidUrl(url) || this.visitedUrls.size + this.queue.size >= this.limit * 2) {
            return;
        }
        // 重複チェックは _isValidUrl で行われているため、このブロックは削除

        // p-queueの型定義エラーを解消するため、オプションを使用せずにタスクのみを追加
        this.queue.add(async () => {
            if (!this._isValidUrl(url) || this.scrapedCount >= this.limit) {
                return;
            }

            log('info', `[Queue: ${this.queue.size}/${this.queue.pending}] Scraping: ${url}`);
            this.visitedUrls.add(url);
            const html = await this._fetchPage(url);

            if (html) {
                const { contentInfo, links } = this._extractContentAndLinks(html, url);
                if (contentInfo.content?.trim()) {
                    this.processedPages.push(contentInfo);
                    this.scrapedCount++;
                    log('info', `(${this.scrapedCount}/${this.limit}) Content extracted from: ${url}`);
                    links.forEach(link => this._enqueueScrape(link));
                } else {
                    log('warn', `No readable content extracted from ${url}`);
                }
            } else {
                log('warn', `Failed to fetch or process ${url}`);
            }
        });
    }

    public async scrape(): Promise<PageInfo[]> {
        log('info', `Starting scrape from ${this.startUrl}, limit=${this.limit}, concurrency=${SCRAPE_CONCURRENCY}`);
        const normalizedStartUrl = this._normalizeUrl(this.startUrl, this.startUrl);
        if (normalizedStartUrl) {
            this._enqueueScrape(normalizedStartUrl);
        } else {
             log('error', `Could not normalize the start URL: ${this.startUrl}`);
             return [];
        }

        await this.queue.onIdle();

        log('info', `Scraping finished. Extracted content from ${this.scrapedCount} pages.`);
        if (this.scrapedCount === 0) {
            log('warn', "No pages with content were successfully processed.");
        }
        return this.processedPages;
    }
}


// --- Qdrant Settings ---
const QDRANT_RETRY_COUNT = 3; // リトライ回数
const QDRANT_RETRY_DELAY_MS = 1000; // リトライ間隔 (ミリ秒)

// --- インデクサークラス ---
class Indexer {
    private readonly collectionName: string;
    private readonly qdrantClient: QdrantClient;
    private readonly embeddingPipeline: FeatureExtractionPipeline;
    private readonly qdrantUrl: string; // qdrantUrl も保持

    constructor(collectionName: string, qdrantUrl: string) { // qdrantUrl を引数で受け取る
        this.collectionName = collectionName;
        this.qdrantUrl = qdrantUrl; // 引数を保持
        log('info', `Initializing Qdrant client for URL: ${this.qdrantUrl}`);
        this.qdrantClient = new QdrantClient({ url: this.qdrantUrl });
        this.embeddingPipeline = embeddingPipeline; // グローバルスコープのものを参照
    }

    /**
     * Checks if the collection already exists in Qdrant.
     * @returns {Promise<boolean>} True if the collection exists, false otherwise.
     * @throws Will throw an error if the check fails for reasons other than 404.
     */
    public async checkCollectionExists(): Promise<boolean> {
        try {
            await this.qdrantClient.getCollection(this.collectionName);
            log('info', `Collection '${this.collectionName}' found.`);
            return true;
        } catch (error: any) {
            if (error.status === 404 || error.message?.includes('Not found')) {
                log('info', `Collection '${this.collectionName}' not found.`);
                return false;
            } else {
                log('error', `Failed to check collection status for '${this.collectionName}': ${error.message}`);
                throw error; // Re-throw unexpected errors
            }
        }
    }

    private _chunkText(text: string, url: string, title: string): Chunk[] {
        const chunks: Chunk[] = [];
        let start = 0;
        const docId = generateStableId(url);

        if (!text?.trim()) {
            log('warn', `Skipping empty content for chunking: ${url}`);
            return [];
        }

        while (start < text.length) {
            const end = start + CHUNK_SIZE;
            const chunkText = text.substring(start, end);
            const chunkId = generateStableId(`${url}::${start}`);

            chunks.push({
                id: chunkId,
                text: chunkText,
                metadata: {
                    source_url: url,
                    source_title: title,
                    doc_id: docId,
                    chunk_char_start: start,
                    text: chunkText,
                }
            });
            start += CHUNK_SIZE - CHUNK_OVERLAP;
            if (start >= text.length) break;
        }
        return chunks;
    }

    private async _embedChunks(chunkTexts: string[]): Promise<number[][]> {
        if (!this.embeddingPipeline) throw new Error("Embedding pipeline not initialized.");
        if (!chunkTexts?.length) return [];

        try {
            // Transformers.js の出力型はモデルに依存する
            const output = await this.embeddingPipeline(chunkTexts, { pooling: 'mean', normalize: true });
            // 出力テンソルの .data から Float32Array を取得し、2次元配列に変換
            const embeddingsData = output.data as Float32Array;
            const numEmbeddings = chunkTexts.length;
            const embeddingDim = embeddingsData.length / numEmbeddings;

            if (embeddingDim !== VECTOR_SIZE) {
                 log('warn', `Embedding dimension mismatch. Expected ${VECTOR_SIZE}, got ${embeddingDim}`);
                 // 必要に応じてエラー処理
            }

            const embeddings: number[][] = [];
            for (let i = 0; i < numEmbeddings; i++) {
                const start = i * embeddingDim;
                const end = start + embeddingDim;
                // Float32Array の一部を通常の配列に変換
                embeddings.push(Array.from(embeddingsData.slice(start, end)));
            }
            return embeddings;
        } catch (error: any) {
            log('error', `Failed to generate embeddings: ${error.message}`);
            throw error;
        }
    }

    private async _ensureCollectionExists(): Promise<void> {
        try {
            await this.qdrantClient.getCollection(this.collectionName);
            log('info', `Collection '${this.collectionName}' already exists.`);
        } catch (error: any) {
            if (error.status === 404 || error.message?.includes('Not found')) {
                log('info', `Collection '${this.collectionName}' not found. Creating...`);
                try {
                    await this.qdrantClient.createCollection(this.collectionName, {
                        vectors: { size: VECTOR_SIZE, distance: 'Cosine' }
                    });
                    log('info', `Collection '${this.collectionName}' created successfully.`);
                } catch (createError: any) {
                    log('error', `Failed to create collection '${this.collectionName}': ${createError.message}`);
                    throw createError;
                }
            } else {
                log('error', `Failed to check collection status for '${this.collectionName}': ${error.message}`);
                throw error;
            }
        }
    }

    private async _upsertWithRetry(pointsBatch: PointStruct[], batchNumber: number): Promise<boolean> {
        for (let attempt = 1; attempt <= QDRANT_RETRY_COUNT; attempt++) {
            try {
                log('debug', `Attempt ${attempt}/${QDRANT_RETRY_COUNT}: Upserting batch ${batchNumber} (${pointsBatch.length} points) to collection '${this.collectionName}'...`);
                await this.qdrantClient.upsert(this.collectionName, { wait: true, points: pointsBatch });
                log('debug', `Batch ${batchNumber} upsert successful.`);
                return true; // 成功したら true を返す
            } catch (e: any) {
                log('warn', `Attempt ${attempt}/${QDRANT_RETRY_COUNT} failed for batch ${batchNumber}: ${e.message}`, e.cause ? `Cause: ${e.cause}` : '');
                if (attempt < QDRANT_RETRY_COUNT) {
                    log('info', `Retrying batch ${batchNumber} in ${QDRANT_RETRY_DELAY_MS}ms...`);
                    await delay(QDRANT_RETRY_DELAY_MS);
                } else {
                    log('error', `Failed to upsert batch ${batchNumber} after ${QDRANT_RETRY_COUNT} attempts.`);
                    return false; // 失敗したら false を返す
                }
            }
        }
        return false; // Should not be reached, but added for type safety
    }


    public async indexDocuments(documents: PageInfo[], forceReindex: boolean = false): Promise<void> {
        await this._ensureCollectionExists();

        if (forceReindex) {
            log('warn', "Force re-index requested, but explicit deletion not implemented.");
        }

        let pointsBatch: PointStruct[] = [];
        let totalChunksProcessed = 0;
        let batchCounter = 0; // バッチ番号カウンター

        log('info', `Starting indexing for ${documents.length} documents...`);

        for (const [docIndex, doc] of documents.entries()) { // インデックスも取得
            log('debug', `Processing document ${docIndex + 1}/${documents.length}: ${doc.url}`);
            const chunks = this._chunkText(doc.content, doc.url, doc.title);
            if (chunks.length === 0) continue;

            const chunkTexts = chunks.map(c => c.text);

            try {
                const embeddings = await this._embedChunks(chunkTexts);
                if (embeddings.length !== chunks.length) {
                     log('error', `Embedding count mismatch for ${doc.url}. Skipping.`);
                     continue;
                }

                for (let i = 0; i < chunks.length; i++) {
                    pointsBatch.push({
                        id: chunks[i].id,
                        vector: embeddings[i],
                        payload: chunks[i].metadata as any,
                    });

                    // バッチサイズに達したら upsert (リトライ付き)
                    if (pointsBatch.length >= QDRANT_BATCH_SIZE) {
                        batchCounter++;
                        const success = await this._upsertWithRetry(pointsBatch, batchCounter);
                        if (!success) {
                            // リトライ失敗時の処理（例：エラーログは既に出力されているので、ここでは何もしないか、特定の処理を追加）
                            log('error', `Skipping remaining points in batch ${batchCounter} due to persistent upsert failure.`);
                        }
                        pointsBatch = []; // バッチをクリア
                    }
                }
                totalChunksProcessed += chunks.length;

            } catch (error: any) {
                 log('error', `Failed to process document ${doc.url}: ${error.message}`);
                 continue;
            }
        }

        // 最後のバッチを upsert (リトライ付き)
        if (pointsBatch.length > 0) {
            batchCounter++;
            await this._upsertWithRetry(pointsBatch, batchCounter);
            // 最後のバッチの失敗時の処理は省略（必要なら追加）
        }

        log('info', `Indexing complete. Processed ${totalChunksProcessed} chunks across ${batchCounter} batches.`);
    }

    public async search(query: string): Promise<QdrantSearchResult[]> {
        if (!query?.trim()) {
             log('warn', "Search query is empty.");
             return [];
        }
        try {
            log('debug', `Generating embedding for query: "${query}"`); // Use debug level
            const queryEmbedding = await this._embedChunks([query]);
            if (!queryEmbedding?.[0]) {
                 log('error', "Failed to generate query embedding.");
                 return [];
            }

            log('debug', `Searching Qdrant collection '${this.collectionName}'...`); // Use debug level
            // Note: QdrantClient.search returns results with payload potentially being null
            const searchResult = await this.qdrantClient.search(this.collectionName, {
                vector: queryEmbedding[0],
                limit: SEARCH_LIMIT,
                with_payload: true // Ensure payload is included
            });
            log('debug', `Qdrant search returned ${searchResult.length} results.`); // Use debug level

            // Map results, ensuring payload exists before accessing its properties
            return searchResult.map(hit => ({
                 score: hit.score,
                 payload: hit.payload as unknown as ChunkMetadata ?? null, // 型安全にキャスト
                 id: hit.id,
            }));

        } catch (error: any) {
            log('error', `Qdrant search failed: ${error.message}`);
            return [];
        }
    }
}


// --- メイン実行関数 ---
async function main() {
    // Restore yargs argument parsing
    const argv = await yargs(hideBin(process.argv))
        .scriptName("qdrant_mcp_server_ts")
        .usage('$0 <start_url> [options]')
        // start_url を positional から option に変更し、必須ではなくす
        .option('start-url', { // positional から option に変更
            alias: 's', // 短縮エイリアスを追加 (任意)
            type: 'string',
            describe: 'The starting URL of the website to scrape (overrides DOCS_URL env var)',
        })
        .option('limit', { alias: 'l', type: 'number', default: DEFAULT_SCRAPE_LIMIT, describe: `Max pages (default: ${DEFAULT_SCRAPE_LIMIT})` })
        .option('match', { alias: 'm', type: 'array', describe: "URL path patterns (prefix match)", default: [] })
        .option('force-reindex', { type: 'boolean', default: false, describe: 'Force re-indexing' })
        // 環境変数をデフォルト値として使用
        .option('collection-name', {
            alias: 'c',
            type: 'string',
            default: process.env.COLLECTION_NAME || DEFAULT_BASE_COLLECTION_NAME,
            describe: 'Base name for the Qdrant collection (overrides COLLECTION_NAME env var)'
        })
        .option('qdrant-url', {
            type: 'string',
            default: process.env.QDRANT_URL || DEFAULT_QDRANT_URL,
            describe: 'URL of the Qdrant instance (overrides QDRANT_URL env var)'
        })
        .option('embedding-model', {
            type: 'string',
            default: process.env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL,
            describe: 'Name of the embedding model to use (overrides EMBEDDING_MODEL env var)'
        })
        .option('debug', { type: 'boolean', default: false, describe: 'Enable debug logging' }) // Add debug flag
        // .demandCommand(1, 'You must provide the start_url.') // 必須ではなくなったので削除
        .help().alias('h', 'help').strict()
        .argv;

    // 型アサーションで argv の型を確定させる
    // yargsの引数を安全に処理
    const rawArgs = argv as Record<string, unknown>;
    const args = {
        // start_url は positional ではなくなったので、rawArgs['start-url'] を参照
        start_url: String(rawArgs['start-url'] || process.env.DOCS_URL || ''), // オプション > 環境変数 > デフォルト空文字
        limit: Number(rawArgs.limit || DEFAULT_SCRAPE_LIMIT),
        match: Array.isArray(rawArgs.match) ? rawArgs.match.map(String) : [],
        forceReindex: Boolean(rawArgs.forceReindex || rawArgs["force-reindex"]),
        // yargs の default で環境変数を考慮済みなので、ここでは rawArgs の値のみ参照
        collectionName: String(rawArgs.collectionName),
        qdrantUrl: String(rawArgs.qdrantUrl),
        embeddingModel: String(rawArgs.embeddingModel),
        debug: Boolean(rawArgs.debug), // Get debug flag value
        _: Array.isArray(rawArgs._) ? rawArgs._ as (string | number)[] : [] as (string | number)[],
        $0: String(rawArgs.$0 || '')
    };

    // start_url の必須チェック (環境変数も考慮)
    if (!args.start_url) {
        log('error', 'Error: start-url argument or DOCS_URL environment variable must be provided.');
        process.exit(1);
    }

    // Set global debug flag based on parsed args
    isDebugEnabled = args.debug;

    // --- Transformers.js モデルロード処理 (main 関数内に移動) ---
    try {
        // @ts-ignore - dynamic import の型推論が難しい場合
        const { pipeline: transPipeline } = await import('@xenova/transformers');
        const embeddingModelName = args.embeddingModel; // args が定義された後で参照
        log('info', `Loading embedding model: ${embeddingModelName}...`);
        embeddingPipeline = await transPipeline('feature-extraction', embeddingModelName, {
            // quantized: true, // 量子化モデルが見つからないエラーのためコメントアウト
            quantized: false, // 明示的に false を設定
            // poolingオプションを削除して型エラーを回避
        }) as FeatureExtractionPipeline;
        log('info', 'Embedding model loaded successfully.');
    } catch (err) {
        log('error', `Failed to load Transformers.js or the model: ${err}`);
        log('error', 'Make sure you have installed "@xenova/transformers" and have internet access for model download.');
        process.exit(1);
    }
    // Removed extraneous closing brace here


    let validatedUrl: string;
    try {
        validatedUrl = new URL(args.start_url).href;
    } catch (e) {
        log('error', `Invalid start URL provided: ${args.start_url}`);
        process.exit(1);
    }

    const sanitizedSiteName = sanitizeForCollectionName(new URL(validatedUrl).hostname);
    const baseCollectionName = args.collectionName; // 引数から取得
    const collectionName = `${baseCollectionName}-${sanitizedSiteName}`;

    // Indexer インスタンスを作成
    const indexer = new Indexer(collectionName, args.qdrantUrl); // qdrantUrl も渡す

    // --- スクレイピングとインデックス作成 (条件付き実行) ---
    log('info', `Starting setup for site: ${validatedUrl}`);
    log('info', `Using Qdrant collection: ${collectionName}`);

    let shouldIndex = true; // デフォルトではインデックス作成を行う
    if (!args.forceReindex) {
        try {
            const collectionExists = await indexer.checkCollectionExists();
            if (collectionExists) {
                log('info', `Collection '${collectionName}' already exists and force-reindex is not specified. Skipping scraping and indexing.`);
                shouldIndex = false;
            }
        } catch (error) {
            log('error', `Failed to check collection existence: ${error}. Proceeding with indexing attempt.`);
            // エラーが発生した場合でも、インデックス作成を試みる (あるいはここで終了させるか)
        }
    } else {
        log('info', "'force-reindex' specified, proceeding with scraping and indexing.");
    }

    if (shouldIndex) {
        const scraper = new Scraper(validatedUrl, args.limit, args.match);
        const documents = await scraper.scrape();
        if (documents?.length > 0) {
            await indexer.indexDocuments(documents, args.forceReindex); // forceReindex は indexDocuments 内でも考慮されるが、明示的に渡す
        } else {
            log('warn', "No documents scraped, skipping indexing.");
        }
        log('info', "Scraping and indexing phase complete.");
    } else {
        log('info', "Setup phase complete (indexing skipped).");
    }

    // --- MCPサーバー設定 ---
    // 元の Server クラスを使用し、capabilities を指定
    const server = new McpServer(
        {
            name: `Qdrant Server for ${sanitizedSiteName}`,
            version: "1.0.0",
        },
        {
            capabilities: {
                tools: {}, // ツール機能のみ有効化
            },
        }
    );

    // --- ツール定義 ---
    const toolName = `ask_${sanitizedSiteName}_content`;
    const toolDescription = `Ask a question about the content of the site ${validatedUrl}. Input is your natural language query.`;

    // ListTools ハンドラ: 提供するツールをリストアップ (元の形式に戻す)
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        log('debug', "Handling ListTools request"); // Use debug level
        // zod を使ってスキーマを定義 (より型安全)
        const inputSchema = z.object({
            query: z.string().describe("Your question about the website content in natural language.")
        });
        return {
            tools: [
                {
                    name: toolName,
                    description: toolDescription,
                    // zod スキーマを JSON Schema 形式に変換して設定 (zod-to-json-schema が必要だが、ここでは手動で記述)
                    inputSchema: {
                        type: "object",
                        properties: {
                            query: {
                                type: "string",
                                description: "Your question about the website content in natural language."
                            }
                        },
                        required: ["query"]
                    }
                    // outputSchema は省略 (デフォルトは text content)
                }
            ]
        };
    });

    // CallTool ハンドラ: ツールが呼び出されたときの処理 (元の形式に戻す)
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        log('debug', `Handling CallTool request for tool: ${request.params.name}`); // Use debug level
        if (request.params.name !== toolName) {
            throw new Error(`Unknown tool: ${request.params.name}`);
        }

        // zod を使って引数を検証 (より安全)
        const inputSchema = z.object({
            query: z.string().min(1, "Query cannot be empty") // 空文字チェックも追加
        });
        let validatedArgs;
        try {
            validatedArgs = inputSchema.parse(request.params.arguments);
        } catch (error) {
            log('error', `Invalid arguments for tool ${toolName}: ${error}`);
            // エラー内容を返す
            return { content: [{ type: 'text', text: `Invalid arguments: ${error}` }], isError: true };
        }
        const query = validatedArgs.query;


        log('info', `Executing search for query: "${query}"`);
        try {
            const searchResults = await indexer.search(query); // Indexerインスタンスを使って検索

            if (!searchResults || searchResults.length === 0) {
                log('info', "No relevant documents found.");
                return { content: [{ type: 'text', text: 'No relevant documents found for your query.' }] };
            }

            // 結果を整形してテキストで返す
            let responseText = "Found relevant content:\n\n";
            searchResults.forEach((result, i) => {
                const payload = result.payload; // payload can be null
                responseText += `--- Result ${i + 1} (Score: ${result.score.toFixed(4)}) ---\n`;
                responseText += `Source: ${payload?.source_url || 'N/A'} (Title: ${payload?.source_title || 'N/A'})\n`;
                responseText += `Content Chunk:\n${payload?.text || 'N/A'}\n`;
                responseText += `--------------------------------------\n\n`;
            });

             log('info', `Search successful, returning ${searchResults.length} results.`);
            return { content: [{ type: 'text', text: responseText.trim() }] };

        } catch (error: any) {
            log('error', `Error during Qdrant search or result formatting: ${error.message}`);
            return {
                 content: [{ type: 'text', text: `An error occurred while processing your query: ${error.message}` }],
                 isError: true // エラー発生を通知
            };
        }
    });

    // --- サーバー起動 ---
    log('info', "Starting MCP server via StdioTransport...");
    const transport = new StdioServerTransport();
    try {
        await server.connect(transport);
        log('info', "MCP server is running and waiting for requests.");
    } catch (error: any) {
        log('error', `Failed to start MCP server: ${error.message}`);
        process.exit(1);
    }
}

// メイン関数の実行
main().catch((error) => {
    log('error', `Unhandled error in main function: ${error.stack || error}`);
    process.exit(1);
});
