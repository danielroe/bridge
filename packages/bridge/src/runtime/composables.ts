import { getCurrentInstance, onBeforeUnmount, isRef, watch, reactive, toRef, isReactive, Ref, set } from 'vue'
import type { CombinedVueInstance } from 'vue/types/vue'
import type { MetaInfo } from 'vue-meta'
import type VueRouter from 'vue-router'
import type { Location, RawLocation, Route, NavigationFailure } from 'vue-router'
import type { RuntimeConfig } from '@nuxt/schema'
import { sendRedirect } from 'h3'
import { defu } from 'defu'
import { useRouter as useVueRouter, useRoute as useVueRoute } from 'vue-router/composables'
import { hasProtocol, joinURL, parseURL } from 'ufo'
import { useNuxtApp, callWithNuxt } from './app'
import { createError, showError } from './error'
import type { NuxtError } from './error'

export { useLazyAsyncData, refreshNuxtData } from './asyncData'
export { useLazyFetch } from './fetch'
export { useCookie } from './cookie'
export { clearError, createError, isNuxtError, throwError, showError, useError } from './error'
export { useRequestHeaders, useRequestEvent } from './ssr'

export * from 'vue'

const mock = () => () => { throw new Error('not implemented') }

export const useAsyncData = mock()
export const useFetch = mock()
export const useHydration = mock()

// Runtime config helper
export const useRuntimeConfig = () => {
  const nuxtApp = useNuxtApp()
  if (nuxtApp._config) {
    return nuxtApp._config as RuntimeConfig
  }

  nuxtApp._config = reactive(nuxtApp.$config)
  return nuxtApp._config as RuntimeConfig
}

// Auto-import equivalents for `vue-router`
export const useRouter = () => {
  if (getCurrentInstance()) {
    return useVueRouter()
  }

  return useNuxtApp()?.nuxt2Context.app.router as VueRouter
}

// This provides an equivalent interface to `vue-router` (unlike legacy implementation)
export const useRoute = () => {
  if (getCurrentInstance()) {
    return useVueRoute()
  }

  const nuxtApp = useNuxtApp()

  if (!nuxtApp._route) {
    Object.defineProperty(nuxtApp, '__route', {
      get: () => nuxtApp.nuxt2Context.app.context.route
    })
    nuxtApp._route = reactive(nuxtApp.__route)
    const router = useRouter()
    router.afterEach(route => Object.assign(nuxtApp._route, route))
  }

  return nuxtApp._route as Route
}

// payload.state is used for vuex by nuxt 2
export const useState = <T> (key: string, init?: (() => T)): Ref<T> => {
  const nuxtApp = useNuxtApp()
  if (!nuxtApp.payload.useState) {
    nuxtApp.payload.useState = {}
  }
  if (!isReactive(nuxtApp.payload.useState)) {
    nuxtApp.payload.useState = reactive(nuxtApp.payload.useState)
  }

  // see @vuejs/composition-api reactivity tracking on a reactive object with set
  if (!(key in nuxtApp.payload.useState)) {
    set(nuxtApp.payload.useState, key, undefined)
  }

  const state = toRef(nuxtApp.payload.useState, key)
  if (state.value === undefined && init) {
    state.value = init()
  }
  return state
}

type Reffed<T extends Record<string, any>> = {
  [P in keyof T]: T[P] extends Array<infer A> ? Ref<Array<Reffed<A>>> | Array<Reffed<A>> : T[P] extends Record<string, any> ? Reffed<T[P]> | Ref<Reffed<T[P]>> : T[P] | Ref<T[P]>
}

function unwrap (value: any): Record<string, any> {
  if (!value || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') { return value }
  if (Array.isArray(value)) { return value.map(i => unwrap(i)) }
  if (isRef(value)) { return unwrap(value.value) }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, unwrap(value)]))
  }
  return value
}

type AugmentedComponent = CombinedVueInstance<Vue, object, object, object, Record<never, any>> & {
  _vueMeta?: boolean
  $metaInfo?: MetaInfo
}

/** internal */
function metaInfoFromOptions (metaOptions: Reffed<MetaInfo> | (() => Reffed<MetaInfo>)) {
  return metaOptions instanceof Function ? metaOptions : () => metaOptions
}

export const useNuxt2Meta = (metaOptions: Reffed<MetaInfo> | (() => Reffed<MetaInfo>)) => {
  let vm: AugmentedComponent | null = null
  try {
    vm = getCurrentInstance()!.proxy as AugmentedComponent
    const meta = vm.$meta()
    const $root = vm.$root

    if (!vm._vueMeta) {
      vm._vueMeta = true

      let parent = vm.$parent as AugmentedComponent
      while (parent && parent !== $root) {
        if (parent._vueMeta === undefined) {
          parent._vueMeta = false
        }
        parent = parent.$parent
      }
    }
    // @ts-ignore
    vm.$options.head = vm.$options.head || {}

    const unwatch = watch(metaInfoFromOptions(metaOptions), (metaInfo: MetaInfo) => {
      vm.$metaInfo = {
        ...vm.$metaInfo || {},
        ...unwrap(metaInfo)
      }
      if (process.client) {
        meta.refresh()
      }
    }, { immediate: true, deep: true })

    onBeforeUnmount(unwatch)
  } catch {
    const app = (useNuxtApp().nuxt2Context as any).app
    if (typeof app.head === 'function') {
      const originalHead = app.head
      app.head = function () {
        const head = originalHead.call(this) || {}
        return defu(unwrap(metaInfoFromOptions(metaOptions)()), head)
      }
    } else {
      app.head = defu(unwrap(metaInfoFromOptions(metaOptions)()), app.head)
    }
  }
}

export interface AddRouteMiddlewareOptions {
  global?: boolean
}

/** internal */
function convertToLegacyMiddleware (middleware) {
  return async (ctx: any) => {
    // because the middleware is executed before the plugin
    ctx.$_nuxtApp._processingMiddleware = true
    const result = await callWithNuxt(ctx.$_nuxtApp, middleware, [ctx.route, ctx.from])
    delete ctx.$_nuxtApp._processingMiddleware
    if (result instanceof Error) {
      return ctx.error(result)
    }
    if (result) {
      return ctx.redirect(result)
    }
    return result
  }
}

const isProcessingMiddleware = () => {
  try {
    if (useNuxtApp()._processingMiddleware) {
      return true
    }
  } catch {
    // Within an async middleware
    return true
  }
  return false
}

export interface NavigateToOptions {
  replace?: boolean
  redirectCode?: number,
  external?: boolean
}

export const navigateTo = (to: RawLocation | undefined | null, options?: NavigateToOptions): Promise<void | Route | NavigationFailure> | RawLocation | Route => {
  if (!to) {
    to = '/'
  }
  const toPath = typeof to === 'string' ? to : (to.path || '/')
  const isExternal = hasProtocol(toPath, true)
  if (isExternal && !options?.external) {
    throw new Error('Navigating to external URL is not allowed by default. Use `nagivateTo (url, { external: true })`.')
  }
  if (isExternal && parseURL(toPath).protocol === 'script:') {
    throw new Error('Cannot navigate to an URL with script protocol.')
  }
  // Early redirect on client-side
  if (process.client && !isExternal && isProcessingMiddleware()) {
    return to
  }
  const router = useRouter()
  if (process.server) {
    const nuxtApp = useNuxtApp()
    if (nuxtApp.ssrContext && nuxtApp.ssrContext.event) {
      const redirectLocation = isExternal ? toPath : joinURL(useRuntimeConfig().app.baseURL, router.resolve(to).resolved.fullPath || '/')
      return nuxtApp.callHook('app:redirected').then(() => sendRedirect(nuxtApp.ssrContext!.event, redirectLocation, options?.redirectCode || 302))
    }
  }
  // Client-side redirection using vue-router
  if (isExternal) {
    if (options?.replace) {
      location.replace(toPath)
    } else {
      location.href = toPath
    }
    return Promise.resolve()
  }
  return options?.replace ? router.replace(to) : router.push(to)
}

/** This will abort navigation within a Nuxt route middleware handler. */
export const abortNavigation = (err?: string | Partial<NuxtError>) => {
  if (process.dev && !isProcessingMiddleware()) {
    throw new Error('abortNavigation() is only usable inside a route middleware handler.')
  }
  if (!err) { return false }

  err = createError(err)

  if (err.fatal) {
    const nuxtApp = useNuxtApp()
    callWithNuxt(nuxtApp, showError, [err as NuxtError])
  }

  throw err
}

type RouteMiddlewareReturn = void | Error | string | Location | boolean | Route

export interface RouteMiddleware {
  (to: Route, from: Route): RouteMiddlewareReturn | Promise<RouteMiddlewareReturn>
}

export const defineNuxtRouteMiddleware = (middleware: RouteMiddleware) => convertToLegacyMiddleware(middleware)

interface AddRouteMiddleware {
  (name: string, middleware: RouteMiddleware, options?: AddRouteMiddlewareOptions): void
  (middleware: RouteMiddleware): void
}

export const addRouteMiddleware: AddRouteMiddleware = (name: string | RouteMiddleware, middleware?: RouteMiddleware, options: AddRouteMiddlewareOptions = {}) => {
  const nuxtApp = useNuxtApp()
  if (options.global || typeof name === 'function') {
    nuxtApp._middleware.global.push(typeof name === 'function' ? name : middleware)
  } else {
    nuxtApp._middleware.named[name] = convertToLegacyMiddleware(middleware)
  }
}
