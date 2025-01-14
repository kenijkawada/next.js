import type { NextRouter, Url } from '../router'

import { searchParamsToUrlQuery } from './querystring'
import { formatWithValidation } from './format-url'
import { omit } from './omit'
import { normalizeRepeatedSlashes } from '../../utils'
import { normalizePathTrailingSlash } from '../../../../client/normalize-trailing-slash'
import { isLocalURL } from './is-local-url'
import { isDynamicRoute } from './is-dynamic'
import { interpolateAs } from './interpolate-as'

/**
 * Resolves a given hyperlink with a certain router state (basePath not included).
 * Preserves absolute urls.
 */
export function resolveHref(
  router: NextRouter,
  href: Url,
  resolveAs: true
): [string, string] | [string]
export function resolveHref(
  router: NextRouter,
  href: Url,
  resolveAs?: false
): string
export function resolveHref(
  router: NextRouter,
  href: Url,
  resolveAs?: boolean
): [string, string] | [string] | string {
  // we use a dummy base url for relative urls
  let base: URL
  let urlAsString = typeof href === 'string' ? href : formatWithValidation(href)

  // repeated slashes and backslashes in the URL are considered
  // invalid and will never match a Next.js page/file
  const urlProtoMatch = urlAsString.match(/^[a-zA-Z]{1,}:\/\//)
  const urlAsStringNoProto = urlProtoMatch
    ? urlAsString.slice(urlProtoMatch[0].length)
    : urlAsString

  const urlParts = urlAsStringNoProto.split('?')

  if ((urlParts[0] || '').match(/(\/\/|\\)/)) {
    console.error(
      `Invalid href passed to next/router: ${urlAsString}, repeated forward-slashes (//) or backslashes \\ are not valid in the href`
    )
    const normalizedUrl = normalizeRepeatedSlashes(urlAsStringNoProto)
    urlAsString = (urlProtoMatch ? urlProtoMatch[0] : '') + normalizedUrl
  }

  // Return because it cannot be routed by the Next.js router
  if (!isLocalURL(urlAsString)) {
    return (resolveAs ? [urlAsString] : urlAsString) as string
  }

  try {
    base = new URL(
      urlAsString.startsWith('#') ? router.asPath : router.pathname,
      'http://n'
    )
  } catch (_) {
    // fallback to / for invalid asPath values e.g. //
    base = new URL('/', 'http://n')
  }

  try {
    const finalUrl = new URL(urlAsString, base)
    finalUrl.pathname = normalizePathTrailingSlash(finalUrl.pathname)
    let interpolatedAs = ''

    if (
      isDynamicRoute(finalUrl.pathname) &&
      finalUrl.searchParams &&
      resolveAs
    ) {
      const query = searchParamsToUrlQuery(finalUrl.searchParams)

      const { result, params } = interpolateAs(
        finalUrl.pathname,
        finalUrl.pathname,
        query
      )

      if (result) {
        interpolatedAs = formatWithValidation({
          pathname: result,
          hash: finalUrl.hash,
          query: omit(query, params),
        })
      }
    }

    // if the origin didn't change, it means we received a relative href
    const resolvedHref =
      finalUrl.origin === base.origin
        ? finalUrl.href.slice(finalUrl.origin.length)
        : finalUrl.href

    return resolveAs
      ? [resolvedHref, interpolatedAs || resolvedHref]
      : resolvedHref
  } catch (_) {
    return resolveAs ? [urlAsString] : urlAsString
  }
}
