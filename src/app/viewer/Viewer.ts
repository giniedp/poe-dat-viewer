import { DatFile } from '../dat/dat-file'
import { analyze, ColumnStats } from '../dat/analysis'
import { Header, createHeaderFromSelected, byteView } from './headers'
import { selectColsByHeader, clearColumnSelection } from './selection'
import { calcRowNumLength, cacheHeaderDataView } from './formatting'
import { DatSerializedHeader, getHeaderLength, validateImportedHeader, serializeHeaders } from '../exporters/internal'
import { updateFileHeaders } from '../dat/db'
import { CPUTask } from '../cpu-task'
import { readColumn } from '../dat/reader'
import { settings } from '@/app/workbench/workbench-core'

export interface StateColumn {
  readonly offset: number
  readonly colNum99: string
  readonly colNum100: string
  selected: boolean
  header: Header | null
  dataStart: boolean
  readonly stats: {
    string: boolean
    array: boolean
    b00: boolean
    nullable: boolean
    bMax: string
  }
}

const ROW_NUM_MIN_LENGTH = 4

export class Viewer {
  headers = [] as Header[]
  columns = [] as StateColumn[]
  datFile = null as DatFile | null
  columnStats = [] as ColumnStats[]
  rowNumberLength = -1
  editHeader = null as Header | null
  rowSorting = null as number[] | null

  async loadDat (parsed: DatFile, overrideHeaders?: DatSerializedHeader[]) {
    try {
      await this._loadDat(parsed)
      try {
        const headers = overrideHeaders || parsed.meta.headers
        await this.tryImportHeaders(headers)
      } catch (e) {
        window.alert(e.message)
      }
    } catch (e) {
      window.alert(e.message)
      throw e
    }
  }

  private async _loadDat (parsed: DatFile) {
    this.columnStats = await analyze(parsed)
    this.rowNumberLength = calcRowNumLength(parsed.rowCount, settings.rowNumStart, ROW_NUM_MIN_LENGTH)
    this.datFile = parsed
    this.columns = this.stateColumns(this.columnStats)
    this.rowSorting = null
    if (parsed.rowLength) {
      this.headers = [{
        name: null,
        offset: 0,
        length: parsed.rowLength,
        type: byteView()
      }]
    } else {
      this.headers = []
    }
  }

  stateColumns (columnStats: ColumnStats[]) {
    const columns = new Array(columnStats.length).fill(undefined)
      .map<StateColumn>((_, idx) => ({
        offset: idx,
        colNum99: String((idx + settings.colNumStart) % 100).padStart(2, '0'),
        // colNum100: String(Math.floor((idx + settings.colNumStart) / 100)),
        colNum100: String(idx + settings.colNumStart).padStart(2, '0'),
        selected: false,
        header: null,
        dataStart: false,
        stats: {
          string: false,
          array: false,
          b00: columnStats[idx].b00,
          bMax: columnStats[idx].bMax.toString(16).padStart(2, '0'),
          nullable: false
        }
      }))

    for (let idx = 0; idx < columnStats.length; idx += 1) {
      const stat = columnStats[idx]
      if (stat.refString) {
        for (let k = 0; k < stat.memsize; k += 1) {
          columns[idx + k].stats.string = true
        }
      }
      if (stat.refArray) {
        for (let k = 0; k < stat.memsize * 2; k += 1) {
          columns[idx + k].stats.array = true
        }
      }
      if (stat.nullableMemsize) {
        for (let k = 0; k < stat.memsize; k += 1) {
          columns[idx + k].stats.nullable = true
        }
      }
    }

    return columns
  }

  async tryImportHeaders (serialized: DatSerializedHeader[]) {
    const { datFile, columns, columnStats, headers } = this
    let start = await CPUTask.yield()

    let offset = 0
    for (const hdrSerialized of serialized) {
      const headerLength = getHeaderLength(hdrSerialized, datFile!.memsize)
      if (hdrSerialized.name == null) {
        offset += headerLength
        continue
      }

      let header = {
        length: headerLength,
        offset: offset,
        type: hdrSerialized.type
      } as Header

      const isValid = validateImportedHeader(header, columnStats)
      if (!isValid) {
        throw new Error('The schema is invalid.')
      }

      selectColsByHeader(header, columns)
      header = createHeaderFromSelected(columns, headers)
      header.name = hdrSerialized.name
      clearColumnSelection(columns)

      const type = hdrSerialized.type
      if (type.boolean || type.decimal || type.integer || type.key || type.string) {
        header.type = type
        cacheHeaderDataView(header, this.datFile!)
        this.disableByteView(header)
      }

      offset += headerLength

      if (CPUTask.mustYield(start)) {
        start = await CPUTask.yield()
      }
    }
  }

  async saveHeadersToFileCache () {
    await updateFileHeaders(
      this.datFile!.meta.name,
      serializeHeaders(this.headers)
    )
  }

  disableByteView (header: Header) {
    const { columns } = this
    header.type.byteView = undefined
    const colIdx = columns.findIndex(col => col.offset === header.offset)
    columns.splice(colIdx + 1, header.length - 1)
    columns[colIdx].header = header
    columns[colIdx].selected = false
  }

  enableByteView (header: Header) {
    const { columns, columnStats } = this
    header.type.byteView = { array: false }
    const colIdx = columns.findIndex(col => col.offset === header.offset)
    const fresh = this.stateColumns(columnStats)
    columns.splice(colIdx + 1, 0, ...fresh.slice(header.offset + 1, header.offset + header.length))
    columns[colIdx].header = null
  }

  collectData () {
    const columns = this.headers
      .filter(({ type }) => type.boolean || type.decimal || type.integer || type.key || type.string)
      .map((header, idx) => ({
        name: header.name || `Unknown${idx + 1}`,
        data: (() => {
          const data = header.cachedView?.entriesRaw || readColumn(header, this.datFile!)

          if (header.type.key?.foreign) {
            if (!header.type.ref?.array) {
              const data_ = data as ({ rid: number, unknown: number } | null)[]
              if (!data_.every(row => row == null || row.unknown === 0)) {
                throw new Error('never')
              }
              return data_.map(row => row && row.rid)
            } else {
              const data_ = data as (Array<{ rid: number, unknown: number }>)[]
              if (!data_.every(row => row.every(entry => entry.unknown === 0))) {
                throw new Error('never')
              }
              return data_.map(row => row.map(entry => entry.rid))
            }
          }

          return data
        })()
      }))

    columns.unshift({
      name: '_rid',
      data: Array(this.datFile!.rowCount).fill(undefined)
        .map((_, idx) => idx)
    })

    return Array(this.datFile!.rowCount).fill(undefined)
      .map((_, idx) => Object.fromEntries(
        columns.map(col => [col.name, col.data[idx]])
      ))
  }
}
