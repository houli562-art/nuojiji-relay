// QQ 橋接（QQ 開放平台官方機器人，單聊 + 群聊 @）。
// 群聊補丁 v1（2026-11-26）：在原單聊基礎上加群聊，只回 @ 機器人的群消息，
//   用同一個 Worker / 同一個回調網址（https://chenshen.site/qq/hook/...），不用另起一套。
// 流程和 iMessage 一樣是「平台把訊息推到中繼網址 → 攢一會兒 → 回覆」，所以沿用 ImessageBridgeCore 的
// 排隊 / 連發合併 / 收媒體 / 公開檔案，只換掉 QQ 特有的：
//   - 設定：AppID + AppSecret（中繼換 access_token 驗證），回調網址讓用戶貼到 QQ 開放平台
//   - 收 webhook：Ed25519 驗簽 + 回調地址驗證（op 13）
//   - 綁定：任何人都能私聊機器人 → 只認「發過綁定碼」的那個 QQ（openid），別人發的不回、不花 AI 額度
//   - 發送：有用戶剛發的 msg_id → 被動回覆（每條最多 4 次）；用完 / 過期 → 主動消息
//
// QQ 特有 storage key：
//   acc       { appId, appSecret, hookToken, publicBase, userOpenid, bindCode, createdAt, verifiedAt }
//   qqToken   { token, expiresAt }
//   qqReply   { msgId, at, used }   最近一條用戶訊息（被動回覆用）
//   群聊新增：
//   qqGroup       { groupOpenid, msgId, at, used }  最近一個群 @ 的上下文（發群消息用）
//   qqGroupReply  同上，發送時讀這個（和 qqReply 分開，私聊群聊互不搶次數）
//   pendingGroup / pendingGroupSince  群消息排隊（和單聊 pending 分開，免得群消息回進私聊）

import { ImessageBridgeCore } from '../imessage/imessageCore.js';
import { now, replyWaitMs, replyWaitCapMs } from '../chatbridge/baseCore.js';
import { bytesToB64 } from '../wechat/ilinkClient.js';
import {
    fetchAccessToken, qqCall, qqVerify, qqValidationReply, parseC2c, parseGroupAt, isPassiveExpired,
    FileType, PASSIVE_WINDOW_MS, PASSIVE_MAX, GROUP_PASSIVE_WINDOW_MS, GROUP_PASSIVE_MAX,
} from './qqApi.js';

const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, '0')).join('');
const randomCode = () => String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));

export class QqBridgeCore extends ImessageBridgeCore {
    constructor(storage, env, hooks) {
        super(storage, env, hooks, { prefix: '/qq', label: 'QQ', logPrefix: 'qq' });
    }

    async handleChannel(method, path, query, body) {
        switch (`${method} ${path}`) {
            case 'POST /qq/setup': return this.setup(body || {});
            case 'POST /qq/unbind': return this.unbind();
            case 'POST /qq/test': return this.sendTest();
            case 'POST /qq/rebind': return this.rebind();
            default: return null;
        }
    }

    _webhookUrl(acc, inboxId) {
        return `${acc.publicBase}/qq/hook/${encodeURIComponent(inboxId)}/${acc.hookToken}`;
    }

    async channelStatus() {
        const [acc, inboxId, lastUserAt, qqGroup] = await Promise.all([this.s.get('acc'), this.s.get('inbox'), this.s.get('lastUserAt'), this.s.get('qqGroup')]);
        return {
            bound: !!acc,
            appId: acc?.appId || '',
            linked: !!acc?.userOpenid,
            groupEnabled: true,
            lastGroupOpenid: qqGroup?.groupOpenid || '',
            lastGroupAt: qqGroup?.at || 0,
            // 還沒認到用戶本人 → 顯示綁定碼，讓用戶在 QQ 裡發給機器人
            bindCode: acc && !acc.userOpenid ? acc.bindCode : '',
            webhookUrl: acc && inboxId ? this._webhookUrl(acc, inboxId) : '',
            verifiedAt: acc?.verifiedAt || 0,
            lastUserAt: lastUserAt || 0,
        };
    }

    // 手機端填 AppID / AppSecret：先換一次 token 確認對，再存
    async setup(body) {
        const appId = String(body.appId || '').trim();
        const appSecret = String(body.appSecret || '').trim();
        if (!appId || !appSecret) return { status: 400, json: { error: 'appId / appSecret required' } };
        if (!body.publicBase) return { status: 400, json: { error: 'publicBase required' } };
        let tok;
        try { tok = await fetchAccessToken(appId, appSecret); } catch (e) {
            return { status: 400, json: { error: String(e?.message || e) } };
        }
        const prev = (await this.s.get('acc')) || {};
        const same = prev.appId === appId;
        const acc = {
            appId, appSecret,
            // 換機器人 → 換新回調網址、重新綁定
            hookToken: same && prev.hookToken ? prev.hookToken : randomToken(),
            publicBase: String(body.publicBase).replace(/\/+$/, ''),
            userOpenid: same ? (prev.userOpenid || '') : '',
            bindCode: same && prev.bindCode ? prev.bindCode : randomCode(),
            verifiedAt: same ? (prev.verifiedAt || 0) : 0,
            createdAt: prev.createdAt || now(),
        };
        await this.s.put('acc', acc);
        await this.s.put('qqToken', tok);
        const inboxId = await this.s.get('inbox');
        return { json: { ok: true, webhookUrl: this._webhookUrl(acc, inboxId), bindCode: acc.userOpenid ? '' : acc.bindCode, linked: !!acc.userOpenid } };
    }

    // 換一個 QQ 號聊：清掉已綁定的人，發新綁定碼
    async rebind() {
        const acc = await this.s.get('acc');
        if (!acc) return { status: 400, json: { error: 'not set up' } };
        acc.userOpenid = '';
        acc.bindCode = randomCode();
        await this.s.put('acc', acc);
        await this.s.delete('qqReply');
        await this.s.delete('qqGroupReply');
        return { json: { ok: true, bindCode: acc.bindCode } };
    }

    async unbind() {
        await Promise.all(['acc', 'qqToken', 'qqReply', 'qqGroup', 'qqGroupReply', 'pending', 'pendingSince', 'pendingGroup', 'pendingGroupSince', 'seen'].map((k) => this.s.delete(k)));
        await this.hooks.schedule(null);
        return { json: { ok: true } };
    }

    async sendTest() {
        const opened = await this.openChannel();
        if (!opened?.chan) return { status: 400, json: { ok: false, error: opened?.reason || 'not set up' } };
        try {
            await opened.chan.sendText('糯叽机已连接 QQ。直接回这条消息就能和角色聊天，发「/切换」换角色。');
            return { json: { ok: true } };
        } catch (e) {
            return { status: 502, json: { ok: false, error: String(e?.message || e) } };
        }
    }

    async _token(acc) {
        const t = await this.s.get('qqToken');
        if (t?.token && t.expiresAt - now() > 120000) return t.token;
        const fresh = await fetchAccessToken(acc.appId, acc.appSecret);
        await this.s.put('qqToken', fresh);
        return fresh.token;
    }

    // ---------- 發送通道 ----------
    _chanFor(acc) {
        const base = super._chanFor({ ...acc, provider: null }); // 拿 takeNew（排隊裡的新訊息）
        const self = this;
        const path = `/v2/users/${encodeURIComponent(acc.userOpenid)}`;

        // 發一條：能被動回覆就帶 msg_id（每條用戶訊息最多 4 次、60 分鐘內），否則主動發
        async function send(body) {
            const token = await self._token(acc);
            const ctx = await self.s.get('qqReply');
            if (ctx?.msgId && now() - ctx.at < PASSIVE_WINDOW_MS && (ctx.used || 0) < PASSIVE_MAX) {
                const seq = (ctx.used || 0) + 1;
                try {
                    const r = await qqCall(token, 'POST', `${path}/messages`, { ...body, msg_id: ctx.msgId, msg_seq: seq });
                    await self.s.put('qqReply', { ...ctx, used: seq });
                    return r;
                } catch (e) {
                    if (!isPassiveExpired(e)) throw e;
                    await self.s.put('qqReply', { ...ctx, used: PASSIVE_MAX }); // 過期 / 次數用完 → 這條之後都主動發
                }
            }
            return qqCall(token, 'POST', `${path}/messages`, { ...body, msg_seq: Math.floor(Math.random() * 1e6) + 1 });
        }

        // 富媒體：優先把位元組直接傳給 QQ（file_data）。QQ 伺服器在國內，讓它自己去抓中繼網址
        // （*.workers.dev 被牆）會失敗 → 退成「[表情] 名稱」文字；直傳失敗才退回網址
        async function upload(fileType, extra) {
            const token = await self._token(acc);
            const up = await qqCall(token, 'POST', `${path}/files`, { file_type: fileType, srv_send_msg: false, ...extra });
            if (!up?.file_info) throw new Error('QQ upload: no file_info');
            return up.file_info;
        }
        async function sendMedia(fileType, url, bytes) {
            let fileInfo = null;
            let firstErr = null;
            if (bytes?.length) {
                try { fileInfo = await upload(fileType, { file_data: bytesToB64(bytes) }); } catch (e) { firstErr = e; }
            }
            if (!fileInfo) {
                try { fileInfo = await upload(fileType, { url }); } catch (e) { throw firstErr || e; }
            }
            return send({ msg_type: 7, media: { file_info: fileInfo } });
        }
        // 中繼上的（stk: / om:）直接讀；外部網址由中繼先下載（Cloudflare 抓得到海外圖床）
        async function bytesOf(ref) {
            const local = await self.loadSticker(ref);
            if (local) return local.bytes;
            if (!/^https?:\/\//i.test(String(ref || ''))) return null;
            try {
                const res = await fetch(ref);
                if (!res.ok) return null;
                const b = new Uint8Array(await res.arrayBuffer());
                return b.length && b.length <= 20 * 1024 * 1024 ? b : null;
            } catch { return null; }
        }

        return {
            budget: Infinity,
            takeNew: base.takeNew,
            sendText: (text) => send({ msg_type: 0, content: text }),
            // 中繼存的圖（本機表情 / 手機補發的照片）→ 給 QQ 一個中繼上的公開網址去抓
            sendSticker: async (url) => sendMedia(FileType.IMAGE, await self._mediaUrl(acc, url), await bytesOf(url)),
            // 角色拍的視頻（mp4）
            sendVideo: async (url) => sendMedia(FileType.VIDEO, await self._mediaUrl(acc, url), await bytesOf(url)),
            // 合成語音（mp3）：先試語音條；QQ 只認 SILK 的話退成檔案發
            async sendVoice(mp3, label) {
                const id = await self._putPublic(mp3, 'audio/mpeg', 'mp3');
                const url = self._pubUrl(acc, await self.s.get('inbox'), id);
                try {
                    await sendMedia(FileType.VOICE, url, mp3);
                } catch (e) {
                    console.warn('[qq] voice as voice failed, send as file:', e?.message);
                    await sendMedia(FileType.FILE, `${url}?name=${encodeURIComponent(`${label || 'voice'}.mp3`)}`, mp3);
                }
            },
            // 「對方正在輸入」：只在還能被動回覆時發（需要 msg_id）
            async typing(on) {
                if (!on || this._typed) return;
                this._typed = true;
                try {
                    const ctx = await self.s.get('qqReply');
                    if (ctx?.msgId && now() - ctx.at < PASSIVE_WINDOW_MS && (ctx.used || 0) < PASSIVE_MAX - 1) {
                        await send({ msg_type: 6, input_notify: { input_type: 1, input_second: 60 } });
                    }
                } catch { /* 沒有輸入中提示照樣回 */ }
            },
        };
    }


    // ---------- 群聊發送通道 ----------
    // 和單聊 _chanFor 一樣，只是路徑換成 /v2/groups/{group_openid}，被動窗口約 5 分鐘。
    // 語音在群裡只認 SILK，mp3 大概率失敗 → 直接退成文字，免得整輪卡住。
    _chanForGroup(acc, groupCtx) {
        const self = this;
        const groupOpenid = groupCtx?.groupOpenid || '';
        const path = `/v2/groups/${encodeURIComponent(groupOpenid)}`;
        async function send(body) {
            const token = await self._token(acc);
            const ctx = await self.s.get('qqGroupReply');
            if (ctx?.groupOpenid === groupOpenid && ctx?.msgId && now() - ctx.at < GROUP_PASSIVE_WINDOW_MS && (ctx.used || 0) < GROUP_PASSIVE_MAX) {
                const seq = (ctx.used || 0) + 1;
                try {
                    const r = await qqCall(token, 'POST', `${path}/messages`, { ...body, msg_id: ctx.msgId, msg_seq: seq });
                    await self.s.put('qqGroupReply', { ...ctx, used: seq });
                    return r;
                } catch (e) {
                    if (!isPassiveExpired(e)) throw e;
                    await self.s.put('qqGroupReply', { ...ctx, used: GROUP_PASSIVE_MAX });
                }
            }
            return qqCall(token, 'POST', `${path}/messages`, { ...body, msg_seq: Math.floor(Math.random() * 1e6) + 1 });
        }
        async function upload(fileType, extra) {
            const token = await self._token(acc);
            const up = await qqCall(token, 'POST', `${path}/files`, { file_type: fileType, srv_send_msg: false, ...extra });
            if (!up?.file_info) throw new Error('QQ upload: no file_info');
            return up.file_info;
        }
        async function sendMedia(fileType, url, bytes) {
            let fileInfo = null;
            let firstErr = null;
            if (bytes?.length) {
                try { fileInfo = await upload(fileType, { file_data: bytesToB64(bytes) }); } catch (e) { firstErr = e; }
            }
            if (!fileInfo) {
                try { fileInfo = await upload(fileType, { url }); } catch (e) { throw firstErr || e; }
            }
            return send({ msg_type: 7, media: { file_info: fileInfo } });
        }
        async function bytesOf(ref) {
            const local = await self.loadSticker(ref);
            if (local) return local.bytes;
            if (!/^https?:\/\//i.test(String(ref || ''))) return null;
            try {
                const res = await fetch(ref);
                if (!res.ok) return null;
                const b = new Uint8Array(await res.arrayBuffer());
                return b.length && b.length <= 20 * 1024 * 1024 ? b : null;
            } catch { return null; }
        }
        return {
            budget: Infinity,
            // 生成期間群裡又 @ 了 → 交給核心併進這輪重新生成
            async takeNew() {
                const raw = (await self.s.get('pendingGroup')) || [];
                if (!raw.length) return [];
                await self.s.delete('pendingGroup');
                await self.s.delete('pendingGroupSince');
                return self._toPending(raw, this);
            },
            sendText: (text) => send({ msg_type: 0, content: text }),
            sendSticker: async (url) => sendMedia(FileType.IMAGE, await self._mediaUrl(acc, url), await bytesOf(url)),
            sendVideo: async (url) => sendMedia(FileType.VIDEO, await self._mediaUrl(acc, url), await bytesOf(url)),
            async sendVoice(mp3, label, text) {
                // 群語音只認 SILK，mp3 直接發文字，別讓整輪失敗
                await send({ msg_type: 0, content: `[语音] ${String(text || label || '').trim()}`.trim() });
            },
            async typing(on) { /* 群聊沒有輸入中提示，空著 */ },
        };
    }

    // 群消息排隊（和單聊 _enqueue 一樣，只是 key 換成 pendingGroup，發言人名字拼進文字裡）
    async _enqueueGroup(msgs) {
        const seen = (await this.s.get('seen')) || [];
        const pending = (await this.s.get('pendingGroup')) || [];
        let added = 0;
        for (const m of msgs) {
            if (m.id && seen.includes(String(m.id))) continue;
            if (m.id) seen.push(String(m.id));
            const name = String(m.senderName || '').trim();
            pending.push({ text: name && m.text ? `[${name}] ${m.text}` : (m.text || ''), voiceText: m.voiceText || '', mediaUrls: m.mediaUrls || [], ts: m.ts || now() });
            added++;
        }
        if (!added) return 0;
        await this.s.put('seen', seen.slice(-300));
        await this.s.put('pendingGroup', pending);
        await this.s.put('lastUserAt', now());
        const waitMs = replyWaitMs(await this.s.get('cfg'), 5000);
        let since = await this.s.get('pendingGroupSince');
        if (pending.length === added || !since) { since = now(); await this.s.put('pendingGroupSince', since); }
        await this.hooks.schedule(Math.max(500, Math.min(waitMs, since + replyWaitCapMs(waitMs) - now())));
        return added;
    }

    // 排程器：先走父類的單聊，再走群聊。群聊用群通道回，絕不回進私聊。
    async runOnce() {
        const c2c = await super.runOnce();
        const acc = await this.s.get('acc');
        const raw = (await this.s.get('pendingGroup')) || [];
        if (!acc || !raw.length) return c2c;
        const groupCtx = (await this.s.get('qqGroup')) || null;
        if (!groupCtx?.groupOpenid) {
            await this.s.delete('pendingGroup');
            await this.s.delete('pendingGroupSince');
            return c2c;
        }
        await this.s.delete('pendingGroup');
        await this.s.delete('pendingGroupSince');
        const chan = this._chanForGroup(acc, groupCtx);
        const pending = await this._toPending(raw, chan);
        try {
            if (pending.length) await this.replyRound(chan, pending);
            this.lastError = null;
        } catch (e) {
            this.lastError = String(e?.message || e);
            console.warn('[qq-group] reply failed:', this.lastError);
        }
        return c2c;
    }

    async openChannel() {
        const acc = await this.s.get('acc');
        if (!acc) return { reason: 'not set up' };
        if (!acc.userOpenid) return { reason: 'not linked' };
        return { chan: this._chanFor(acc) };
    }

    // ---------- webhook ----------
    async webhook(token, headers, raw) {
        const acc = await this.s.get('acc');
        if (!acc || token !== acc.hookToken) return { status: 404, json: { error: 'not found' } };
        let body;
        try { body = JSON.parse(raw); } catch { return { status: 400, json: { error: 'invalid json' } }; }
        // 回調地址驗證：用 Bot Secret 簽 event_ts + plain_token
        if (body?.op === 13) {
            await this.s.put('acc', { ...acc, verifiedAt: now() });
            return { json: await qqValidationReply(acc.appSecret, body.d) };
        }
        if (!(await qqVerify(acc.appSecret, headers, raw))) return { status: 401, json: { error: 'bad signature' } };
        const ack = { json: { op: 12 } };
        // 群聊：只回 @ 機器人的消息。沒綁定私聊前先不回群（不知道回哪個角色）。
        if (body?.op === 0 && (body?.t === 'GROUP_AT_MESSAGE_CREATE' || body?.t === 'GROUP_MESSAGE_CREATE')) {
            if (body.t !== 'GROUP_AT_MESSAGE_CREATE') return ack; // v1 只回 @，普通群消息不回，免得刷屏
            if (!acc.userOpenid) return ack;
            const g = parseGroupAt(body.d);
            if (!g.groupOpenid || !g.text) return ack;
            const ctx = { groupOpenid: g.groupOpenid, msgId: g.id, at: now(), used: 0 };
            await this.s.put('qqGroup', ctx);
            await this.s.put('qqGroupReply', ctx);
            await this._enqueueGroup([g]);
            return ack;
        }
        if (body?.op !== 0 || body?.t !== 'C2C_MESSAGE_CREATE') return ack;
        const m = parseC2c(body.d);
        if (!m.openid) return ack;

        // 綁定：還沒認到人 → 只認發對綁定碼的那個 QQ
        if (!acc.userOpenid) {
            if (m.text.replace(/\s+/g, '') !== acc.bindCode) return ack;
            const next = { ...acc, userOpenid: m.openid, bindCode: '' };
            await this.s.put('acc', next);
            await this.s.put('qqReply', { msgId: m.id, at: now(), used: 0 });
            await this._chanFor(next).sendText('绑定成功。现在可以直接和角色聊天了，发「/切换」换角色。').catch((e) => { this.lastWarn = { at: now(), text: `QQ 发送失败：${e?.message || e}` }; });
            return ack;
        }
        if (m.openid !== acc.userOpenid) return ack; // 別人發的：不回、不花 AI 額度

        // 最新一條的 msg_id 拿來被動回覆
        await this.s.put('qqReply', { msgId: m.id, at: now(), used: 0 });
        await this._enqueue([m]);
        return ack;
    }
}
