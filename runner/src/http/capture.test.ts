import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  captureId,
  extOf,
  isFolderName,
  normalizeCaptureUrl,
  normalizeMediaUrl,
  ogImageOf,
  oembedErrorOf,
  oembedThumbnailOf,
  originalsOf,
  sizeSegmentOf,
  imageSignatureOf,
  refererFor,
  withSizeSegment,
} from './capture.ts'

test('normalizeCaptureUrl keeps pinimg as image and strips query/hash', () => {
  const image = normalizeCaptureUrl(
    'https://i.pinimg.com/560x/ab/cd/1234.jpg?x=1#top',
  )
  assert.equal(image.kind, 'image')
  assert.equal(image.url, 'https://i.pinimg.com/560x/ab/cd/1234.jpg')

  const page = normalizeCaptureUrl(
    'https://www.pinterest.com/pin/12345/?sender=abc',
  )
  assert.equal(page.kind, 'page')
  assert.equal(page.url, 'https://www.pinterest.com/pin/12345/')

  const pinimgSub = normalizeCaptureUrl('https://i.pinimg.com/originals/x/y/z.png')
  assert.equal(pinimgSub.kind, 'image')

  const short = normalizeCaptureUrl('pin.it/abc123')
  assert.equal(short.kind, 'page')
  assert.equal(short.url, 'https://pin.it/abc123')

  const noScheme = normalizeCaptureUrl('pinterest.com/pin/42')
  assert.equal(noScheme.kind, 'page')

  assert.throws(() => normalizeCaptureUrl('https://example.com/a.jpg'), /只支持/)
  assert.throws(() => normalizeCaptureUrl(''), /url is required/)
})

test('ogImageOf reads both attribute orders and decodes entities', () => {
  const html = `<html><head>
    <meta name="viewport" content="width=device-width">
    <meta property="og:image" content="https://i.pinimg.com/560x/a/b/c.jpg&amp;w=1">
    <meta property="og:title" content="pin">
  </head></html>`
  assert.equal(
    ogImageOf(html),
    'https://i.pinimg.com/560x/a/b/c.jpg&w=1',
  )

  const swapped = `<meta content="https://i.pinimg.com/236x/x/y/z.jpg" property="og:image:secure_url">`
  assert.equal(ogImageOf(swapped), 'https://i.pinimg.com/236x/x/y/z.jpg')

  assert.equal(ogImageOf('<p>nothing</p>'), null)
})

test('originalsOf upgrades sized variants and refuses originals', () => {
  assert.equal(
    originalsOf('https://i.pinimg.com/560x/ab/cd/1234.jpg'),
    'https://i.pinimg.com/originals/ab/cd/1234.jpg',
  )
  assert.equal(
    originalsOf('https://i.pinimg.com/236x/ab/cd/1234.jpg'),
    'https://i.pinimg.com/originals/ab/cd/1234.jpg',
  )
  assert.equal(originalsOf('https://i.pinimg.com/originals/ab/cd/1234.jpg'), null)
  assert.equal(originalsOf('https://example.com/560x/a.jpg'), null)
})

test('extOf reads extension from url', () => {
  assert.equal(extOf('https://i.pinimg.com/a/b/c.png'), '.png')
  assert.equal(extOf('https://i.pinimg.com/a/b/c.JPG?w=1'), '.jpg')
  assert.equal(extOf('https://i.pinimg.com/a/b/c'), '.jpg')
})

test('captureId is sortable and filesystem-safe', () => {
  const id = captureId(new Date(2026, 10, 16, 18, 51, 2))
  assert.match(id, /^20261116-185102-[0-9a-z]{4}$/)
  assert.match(captureId(new Date()), /^\d{8}-\d{6}-[0-9a-z]{4}$/)
})

test('oembed response parsing separates thumbnail from error', () => {
  const good = JSON.stringify({
    version: '1.0',
    title: 'pin',
    thumbnail_url: 'https://i.pinimg.com/236x/ab/cd/1234.jpg',
  })
  assert.equal(oembedThumbnailOf(good), 'https://i.pinimg.com/236x/ab/cd/1234.jpg')
  assert.equal(oembedErrorOf(good), null)

  const dead = JSON.stringify({ error: 'Url was not found: https://...' })
  assert.equal(oembedThumbnailOf(dead), null)
  assert.equal(oembedErrorOf(dead), 'Url was not found: https://...')

  assert.equal(oembedThumbnailOf('<html>not json</html>'), null)
  assert.equal(oembedErrorOf('<html>not json</html>'), null)
  assert.equal(oembedThumbnailOf(''), null)
})

test('normalizeMediaUrl validates and strips hash', () => {
  assert.equal(
    normalizeMediaUrl('https://i.pinimg.com/originals/a/b/c.png#top'),
    'https://i.pinimg.com/originals/a/b/c.png',
  )
  assert.equal(
    normalizeMediaUrl(' http://example.com/img.jpg '),
    'http://example.com/img.jpg',
  )
  assert.throws(() => normalizeMediaUrl(''), /mediaUrl is empty/)
  assert.throws(() => normalizeMediaUrl('not a url'), /invalid mediaUrl/)
  assert.throws(() => normalizeMediaUrl('ftp://x/y.jpg'), /http\(s\)/)
})

test('size segment read and replace support the upgrade ladder', () => {
  assert.equal(sizeSegmentOf('https://i.pinimg.com/736x/ab/cd/1234.jpg'), '736x')
  assert.equal(sizeSegmentOf('https://i.pinimg.com/originals/ab/cd/1234.jpg'), 'originals')
  assert.equal(sizeSegmentOf('https://example.com/a.jpg'), null)

  assert.equal(
    withSizeSegment('https://i.pinimg.com/736x/ab/cd/1234.jpg', '1200x'),
    'https://i.pinimg.com/1200x/ab/cd/1234.jpg',
  )
  assert.equal(withSizeSegment('https://i.pinimg.com/1200x/ab/cd/1234.jpg', '1200x'), null)
  assert.equal(withSizeSegment('https://example.com/a.jpg', '1200x'), null)
})

test('imageSignatureOf extracts pinimg tail hash shared by size variants', () => {
  const a = imageSignatureOf('https://i.pinimg.com/236x/c4/02/68/c402682918f746e90a97e88e24c08c9d.jpg')
  const b = imageSignatureOf('https://i.pinimg.com/originals/c4/02/68/c402682918f746e90a97e88e24c08c9d.jpg')
  assert.equal(a, 'c4/02/68/c402682918f746e90a97e88e24c08c9d.jpg')
  assert.equal(a, b)
  assert.equal(
    imageSignatureOf('https://i.pinimg.com/736x/3e/71/1b/3e711b280907dbc46ecb959a3b75eef0.jpg'),
    '3e/71/1b/3e711b280907dbc46ecb959a3b75eef0.jpg',
  )
  assert.equal(imageSignatureOf('https://example.com/a/b/deadbeefdeadbeef.jpg'), null)
  assert.equal(imageSignatureOf('https://i.pinimg.com/736x/no-hash.jpg'), null)
})

test('imageSignatureOf maps pximg variants to artwork id + page index', () => {
  const master =
    imageSignatureOf('https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/01/02/03/04/05/12345_p0_master1200.jpg')
  assert.equal(master, '12345_p0')
  const square = imageSignatureOf('https://i.pximg.net/img/12345_p0_square1200.jpg')
  assert.equal(square, '12345_p0')
  const original =
    imageSignatureOf('https://i.pximg.net/img-original/img/2026/01/02/03/04/05/12345_p0.png')
  assert.equal(original, '12345_p0')
  assert.equal(master, square)
  assert.equal(master, original)
})

test('refererFor picks pixiv referer for pximg hosts', () => {
  assert.equal(refererFor('https://i.pximg.net/img-original/img/2026/01/01/x/12345_p0.jpg'), 'https://www.pixiv.net/')
  assert.equal(refererFor('https://i.pinimg.com/736x/3e/71/1b/3e711b280907dbc46ecb959a3b75eef0.jpg'), 'https://www.pinterest.com/')
  assert.equal(refererFor('not a url'), 'https://www.pinterest.com/')
})

test('folder names stay lowercase slugs', () => {
  assert.equal(isFolderName('akagi'), true)
  assert.equal(isFolderName('a1_b2-c3'), true)
  assert.equal(isFolderName('_hidden'), false)
  assert.equal(isFolderName('Upper'), false)
  assert.equal(isFolderName(''), false)
  assert.equal(isFolderName('a'.repeat(65)), false)
})
