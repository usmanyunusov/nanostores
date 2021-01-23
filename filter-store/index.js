let { isFirstOlder } = require('@logux/core')
let { track } = require('@logux/client')

let { LoguxClientStore } = require('../logux-client-store')

function cleanOnNoListener (store) {
  store.addListener()()
}

function findIndex (array, sortValue, id) {
  let start = 0
  let end = array.length - 1
  let middle = Math.floor((start + end) / 2)
  while (start <= end) {
    if (sortValue > array[middle][0]) {
      start = middle + 1
    } else if (sortValue < array[middle][0]) {
      end = middle - 1
    } else if (id === array[middle][1]) {
      return middle
    } else if (id > array[middle][1]) {
      start = middle + 1
    } else {
      end = middle - 1
    }
    middle = Math.floor((start + end) / 2)
  }
  return middle + 1
}

class FilterStore extends LoguxClientStore {
  static filter (client, StoreClass, filter = {}, opts = {}) {
    let id = StoreClass.plural + JSON.stringify(filter) + JSON.stringify(opts)
    if (this.loaded && this.loaded.has(id)) {
      return this.loaded.get(id)
    } else {
      let store = this.load(id, client)
      store.filter(StoreClass, filter, opts)
      this.loaded.set(id, store)
      return store
    }
  }

  constructor (id, client) {
    super(id, client)
    this.stores = new Map()
    this.unbindIds = new Map()
    this.unbind = []

    this.isLoading = true
    this.storeLoading = new Promise((resolve, reject) => {
      this.filter = (StoreClass, filter = {}, opts = {}) => {
        if (opts.listChangesOnly) {
          this.listener = () => {}
        } else {
          this.listener = (store, diff) => {
            this.notifyListener(store.id, diff)
          }
        }

        if (opts.sortBy) {
          if (typeof opts.sortBy === 'string') {
            this.sortBy = s => s[opts.sortBy]
          } else {
            this.sortBy = opts.sortBy
          }
          let oldListener = this.listener
          this.listener = (store, diff) => {
            let sortValue = this.sortBy(store)
            let prevSortValue = this.sortValues.get(store.id)
            if (sortValue !== prevSortValue) {
              this.sortValues.set(store.id, sortValue)
              let prevIndex = findIndex(this.sortIndex, prevSortValue, store.id)
              this.sortIndex.splice(prevIndex, 1)
              this.sorted.splice(prevIndex, 1)
              let nextIndex = findIndex(this.sortIndex, sortValue, store.id)
              this.sortIndex.splice(nextIndex, 0, [sortValue, store.id])
              this.sorted.splice(nextIndex, 0, store)
              if (prevIndex !== nextIndex) {
                this.notifyListener('sorted', this.sorted)
              }
            }
            oldListener(store, diff)
          }
          this.sortValues = new Map()
          this.sortIndex = []
          this.sorted = []
        }

        if (process.env.NODE_ENV !== 'production') {
          if (StoreClass.plural === '@logux/maps') {
            throw new Error(`Set ${StoreClass.name}.plural`)
          }
        }
        let createdType = `${StoreClass.plural}/created`
        let createType = `${StoreClass.plural}/create`
        let changedType = `${StoreClass.plural}/changed`
        let changeType = `${StoreClass.plural}/change`
        let deletedType = `${StoreClass.plural}/deleted`
        let deleteType = `${StoreClass.plural}/delete`

        function checkSomeFields (fields) {
          let some = Object.keys(filter).length === 0
          for (let key in filter) {
            if (key in fields) {
              if (fields[key] === filter[key]) {
                some = true
              } else {
                return false
              }
            }
          }
          return some
        }

        function checkAllFields (fields) {
          for (let key in filter) {
            if (fields[key] !== filter[key]) {
              return false
            }
          }
          return true
        }

        if (StoreClass.loaded) {
          for (let store of StoreClass.loaded.values()) {
            if (checkAllFields(store)) this.add(store)
          }
        }

        let ignore = new Set()
        let checking = []
        if (StoreClass.offline) {
          client.log
            .each(async action => {
              if (action.id && !ignore.has(action.id)) {
                let type = action.type
                if (
                  type === createdType ||
                  type === createType ||
                  type === changedType ||
                  type === changeType
                ) {
                  if (checkSomeFields(action.fields)) {
                    let check = async () => {
                      let store = StoreClass.load(action.id, client)
                      if (store.isLoading) await store.storeLoading
                      if (checkAllFields(store)) {
                        this.add(store)
                      } else {
                        cleanOnNoListener(store)
                      }
                    }
                    checking.push(check())
                    ignore.add(action.id)
                  }
                } else if (type === deletedType || type === deleteType) {
                  ignore.add(action.id)
                }
              }
            })
            .then(async () => {
              await Promise.all(checking)
              if (!StoreClass.remote && this.isLoading) {
                this.isLoading = false
                resolve()
              }
            })
        }

        let subscriptionError
        if (StoreClass.remote) {
          client
            .sync({
              type: 'logux/subscribe',
              channel: StoreClass.plural,
              filter
            })
            .then(() => {
              if (this.isLoading) {
                this.isLoading = false
                resolve()
              }
            })
            .catch(e => {
              subscriptionError = true
              reject(e)
            })
        }

        let removeAndListen = (storeId, actionId) => {
          let store = StoreClass.loaded.get(storeId)
          let clear = store.addListener(() => {})
          this.remove(storeId)
          track(client, actionId)
            .then(() => {
              clear()
            })
            .catch(() => {
              this.add(store)
            })
        }

        if (StoreClass.remote) {
          this.unbind.push(() => {
            if (!subscriptionError) {
              client.log.add(
                {
                  type: 'logux/unsubscribe',
                  channel: StoreClass.plural,
                  filter
                },
                { sync: true }
              )
            }
          })
        }

        function setReason (action, meta) {
          if (checkAllFields(action.fields)) {
            meta.reasons.push(id)
          }
        }

        function createAt (storeId) {
          return StoreClass.loaded.get(storeId).createdActionMeta
        }

        this.unbind.push(
          client.log.type(createdType, setReason, { event: 'preadd' }),
          client.log.type(createType, setReason, { event: 'preadd' }),
          client.log.type(createdType, (action, meta) => {
            if (checkAllFields(action.fields)) {
              let store = StoreClass.load(action.id, client)
              store.processCreate(action, meta)
              this.add(store)
            }
          }),
          client.log.type(createType, (action, meta) => {
            if (checkAllFields(action.fields)) {
              let store = StoreClass.load(action.id, client)
              store.processCreate(action, meta)
              this.add(store)
              track(client, meta.id).catch(() => {
                this.remove(action.id)
              })
            }
          }),
          client.log.type(changedType, async action => {
            await Promise.resolve()
            if (this.stores.has(action.id)) {
              if (!checkAllFields(StoreClass.loaded.get(action.id))) {
                this.remove(action.id)
              }
            } else if (checkSomeFields(action.fields)) {
              let store = StoreClass.load(action.id, client)
              if (store.isLoading) await store.storeLoading
              if (checkAllFields(store)) {
                this.add(store)
              } else {
                cleanOnNoListener(store)
              }
            }
          }),
          client.log.type(changeType, async (action, meta) => {
            await Promise.resolve()
            if (this.stores.has(action.id)) {
              if (!checkAllFields(StoreClass.loaded.get(action.id))) {
                removeAndListen(action.id, meta.id)
              }
            } else if (checkSomeFields(action.fields)) {
              let store = StoreClass.load(action.id, client)
              if (store.isLoading) await store.storeLoading
              if (checkAllFields(store)) {
                this.add(store)
                track(client, meta.id).catch(async () => {
                  let unbind = store.addListener(() => {
                    if (!checkAllFields(store)) {
                      this.remove(action.id)
                    }
                    unbind()
                  })
                })
              } else {
                cleanOnNoListener(store)
              }
            }
          }),
          client.log.type(deletedType, (action, meta) => {
            if (
              this.stores.has(action.id) &&
              isFirstOlder(createAt(action.id), meta)
            ) {
              this.remove(action.id)
            }
          }),
          client.log.type(deleteType, (action, meta) => {
            if (
              this.stores.has(action.id) &&
              isFirstOlder(createAt(action.id), meta)
            ) {
              removeAndListen(action.id, meta.id)
            }
          })
        )
      }
    })
  }

  add (store) {
    if (this.stores.has(store.id)) return
    this.unbindIds.set(store.id, store.addListener(this.listener))
    this.stores.set(store.id, store)
    this.notifyListener('stores', this.stores)
    if (this.sortBy) {
      let sortValue = this.sortBy(store)
      this.sortValues.set(store.id, sortValue)
      let index = findIndex(this.sortIndex, sortValue, store.id)
      this.sorted.splice(index, 0, store)
      this.sortIndex.splice(index, 0, [sortValue, store.id])
      this.notifyListener('sorted', this.sorted)
    }
  }

  remove (id) {
    if (!this.stores.has(id)) return
    this.unbindIds.get(id)()
    this.unbindIds.delete(id)
    this.stores.delete(id)
    this.notifyListener('stores', this.stores)
    if (this.sortBy) {
      let sortValue = this.sortValues.get(id)
      this.sortValues.delete(id)
      let index = findIndex(this.sortIndex, sortValue, id)
      this.sortIndex.splice(index, 1)
      this.sorted.splice(index, 1)
      this.notifyListener('sorted', this.sorted)
    }
  }

  destroy () {
    for (let i of this.unbind) i()
    for (let i of this.unbindIds.values()) i()
    this.loguxClient.log.removeReason(this.id)
  }
}

module.exports = { FilterStore }
