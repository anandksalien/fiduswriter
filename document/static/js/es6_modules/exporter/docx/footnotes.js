import {DocxExporterRels} from "./rels"
import {DocxExporterCitations} from "./citations"
import {DocxExporterImages} from "./images"
import {DocxExporterLists} from "./lists"
import {DocxExporterRichtext} from "./richtext"
import {fnSchema} from "../../schema/footnotes"
import {noSpaceTmp} from "../../common/common"
import {descendantNodes} from "../tools/pmJSON"

const DEFAULT_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + noSpaceTmp`
    <w:footnotes xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" mc:Ignorable="w14 wp14">
        <w:footnote w:id="0" w:type="separator">
            <w:p>
                <w:r>
                    <w:separator />
                </w:r>
            </w:p>
        </w:footnote>
        <w:footnote w:id="1" w:type="continuationSeparator">
            <w:p>
                <w:r>
                    <w:continuationSeparator />
                </w:r>
            </w:p>
        </w:footnote>
    </w:footnotes>
    `

const DEFAULT_SETTINGS_XML = noSpaceTmp`
    <w:footnotePr>
        <w:numFmt w:val="decimal"/>
        <w:footnote w:id="0"/>
        <w:footnote w:id="1"/>
    </w:footnotePr>
    `

const DEFAULT_STYLE_FOOTNOTE = noSpaceTmp`
    <w:style w:type="paragraph" w:styleId="Footnote">
        <w:name w:val="Footnote Text" />
        <w:basedOn w:val="Normal" />
        <w:pPr>
            <w:suppressLineNumbers />
            <w:ind w:left="339" w:hanging="339" />
        </w:pPr>
        <w:rPr>
            <w:sz w:val="20" />
            <w:szCs w:val="20" />
        </w:rPr>
    </w:style>
    `

const DEFAULT_STYLE_FOOTNOTE_ANCHOR = noSpaceTmp`
    <w:style w:type="character" w:styleId="FootnoteAnchor">
        <w:name w:val="Footnote Anchor" />
        <w:rPr>
            <w:vertAlign w:val="superscript" />
        </w:rPr>
    </w:style>
    `


export class DocxExporterFootnotes {
    constructor(exporter, pmJSON) {
        this.exporter = exporter
        this.pmJSON = pmJSON
        this.fnPmJSON = false
        this.images = false
        this.citations = false
        this.htmlFootnotes = [] // footnotes in HTML
        this.fnXml = false
        this.ctXml = false
        this.styleXml = false
        this.filePath = 'word/footnotes.xml'
        this.ctFilePath = "[Content_Types].xml"
        this.settingsFilePath = 'word/settings.xml'
        this.styleFilePath = 'word/styles.xml'
    }

    init() {
        let that = this
        this.findFootnotes()
        if (this.htmlFootnotes.length || (this.exporter.citations.citFm.citationType==='note' && this.exporter.citations.citInfos.length)) {
            this.convertFootnotes()
            this.rels = new DocxExporterRels(this.exporter, 'footnotes')
            this.citations = new DocxExporterCitations(this.exporter, this.exporter.bibDB, this.fnPmJSON)
            // Get the citinfos from the main body document so that they will be
            // used for calculating the bibliography as well
            let origCitInfos = this.exporter.citations.citInfos
            this.citations.formatCitations(origCitInfos)
            // Replace the main bibliography with the new one that includes both citations in main document
            // and in the footnotes.
            this.exporter.pmBib = this.citations.pmBib
            this.images = new DocxExporterImages(
                this.exporter,
                this.exporter.imageDB,
                this.rels,
                this.fnPmJSON
            )
            this.lists = new DocxExporterLists(
                this.exporter,
                this.rels,
                this.fnPmJSON
            )
            return this.rels.init().then(function(){
                return that.images.init()
            }).then(function() {
                return that.lists.init()
            }).then(function() {
                return that.initCt()
            }).then(function() {
                return that.setSettings()
            }).then(function() {
                    return that.addStyles()
            }).then(function() {
                return that.createXml()
            })
        } else {
            // No footnotes were found.
            return window.Promise.resolve()
        }
    }

    initCt() {
        let that = this
        return this.exporter.xml.getXml(this.ctFilePath).then(function(ctXml) {
            that.ctXml = ctXml
            that.addRelsToCt()
            return window.Promise.resolve()
        })
    }

    addRelsToCt() {
        let override = this.ctXml.querySelector(`Override[PartName="/${this.filePath}"]`)
        if (!override) {
            let types = this.ctXml.querySelector('Types')
            types.insertAdjacentHTML('beforeEnd', `<Override PartName="/${this.filePath}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>`)
        }
    }

    addStyles() {
        let that = this
        return this.exporter.xml.getXml(this.styleFilePath).then(function(styleXml) {
            that.styleXml = styleXml
            that.addStyle('Footnote', DEFAULT_STYLE_FOOTNOTE)
            that.addStyle('FootnoteAnchor', DEFAULT_STYLE_FOOTNOTE_ANCHOR)
            return window.Promise.resolve()
        })
    }

    addStyle(styleName, xml) {
        if (!this.styleXml.querySelector(`style[*|styleId="${styleName}"]`)) {
            let stylesEl = this.styleXml.querySelector('styles')
            stylesEl.insertAdjacentHTML('beforeEnd', xml)
        }
    }

    findFootnotes() {
        let that = this
        descendantNodes(this.pmJSON).forEach(
            function(node) {
                if (node.type==='footnote') {
                    that.htmlFootnotes.push(node.attrs.contents)
                }
            }
        )
    }

    convertFootnotes() {
        let fnHTML = ''
        this.htmlFootnotes.forEach(function(htmlFn){
            fnHTML += `<div class='footnote-container'>${htmlFn}</div>`
        })
        let fnNode = document.createElement('div')
        fnNode.innerHTML = fnHTML
        this.fnPmJSON = fnSchema.parseDOM(fnNode).toJSON()
    }

    createXml() {
        let that = this
        this.richtext = new DocxExporterRichtext(this.exporter, this.rels, this.citations, this.images)
        this.fnXml = this.richtext.transformRichtext(this.fnPmJSON) // TODO: add max dimensions
        this.exporter.rels.addFootnoteRel()
        return this.exporter.xml.getXml(this.filePath, DEFAULT_XML).then(function(xml){
            let footnotesEl = xml.querySelector('footnotes')
            footnotesEl.insertAdjacentHTML('beforeEnd', that.fnXml)
            that.xml = xml
        })
    }

    setSettings() {
        let that = this
        return this.exporter.xml.getXml(this.settingsFilePath).then(function(settingsXml){
            let footnotePr = settingsXml.querySelector('footnotePr')
            if (!footnotePr) {
                let settingsEl = settingsXml.querySelector('settings')
                settingsEl.insertAdjacentHTML('beforeEnd', DEFAULT_SETTINGS_XML)
            }
            that.settingsXml = settingsXml
            return window.Promise.resolve()
        })
    }

}