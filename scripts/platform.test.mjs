import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchesTargetLanguage } from '../src/main/ocr-language.ts'

test('skip aligned OCR locally, preserving mixed languages and Chinese script conversion', async () => {
  for (const [target, texts, expected] of [
    ['zh-Hans', ['退出', '这是已经识别出来的中文。', '2026'], true],
    ['zh-Hant', ['你好', '這行文字已經是繁體中文。'], true],
    ['zh-Hans', ['這行文字已經是繁體中文。'], false],
    ['zh-Hant', ['这行文字是简体中文。'], false],
    ['zh-Hans', ['日本語の文章です。'], false],
    ['zh-Hans', ['设置', 'Open the settings'], false],
    ['zh-Hans', ['本地识别 OCR 文字，第 10 行。', '在 Windows 11 上按 Ctrl+C。', 'API'], true],
    ['zh-Hant', ['取得 API 金鑰，再按 Ctrl+C 複製。'], true],
    ['zh-Hans', ['设置', 'SAVE CHANGES'], false],
    ['zh-Hans', ['中文和 English text'], false],
    ['ja', ['日本語の文章です。'], true],
    ['en', ['This is an English sentence.', '42'], true],
    ['en', ['This is an English sentence.', 'Enregistrer les modifications'], false],
    ['fr', ['Enregistrer les modifications'], true]
  ]) {
    assert.equal(await matchesTargetLanguage(texts.map((text) => ({ text, score: 0.99 })), target), expected, target + ' / ' + texts.join(' / '))
  }
})

test('unreliable, empty and vertical OCR never bypasses image translation as already Chinese', async () => {
  for (const lines of [
    [], [{ text: '', score: 0 }], [{ text: '名：', score: 0.502 }],
    [{ text: '和', score: 0.99, vertical: true }],
    [{ text: '你好', score: 0.99 }, { text: '', score: 0 }]
  ]) assert.equal(await matchesTargetLanguage(lines, 'zh-Hans'), false)
})
