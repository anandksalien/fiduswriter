
import {
    EditorState
} from "prosemirror-state"
import {
    ChangeSet
} from 'prosemirror-changeset'
import {
    EditorView
} from "prosemirror-view"
import {
    Mapping,
    AddMarkStep,
    RemoveMarkStep,
    ReplaceStep
} from "prosemirror-transform"
import {
    showSystemMessage,
    Dialog,
} from "../../common"
import {
    recreateTransform
} from "./recreate_transform"
import {
    trackedTransaction,
} from "../track"
import { 
    diffPlugin,
    removeMarks
} from "../state_plugins/merge_diff"
import { 
    FootnoteView 
} from "../footnotes/nodeview"
import {
    baseKeymap
} from "prosemirror-commands"
import {
    keymap
} from "prosemirror-keymap"
import {
    collab
} from "prosemirror-collab"
import {
    history
} from "prosemirror-history"
import {
    tableEditing
} from "prosemirror-tables"
import {
    dropCursor
} from "prosemirror-dropcursor"
import {
    gapCursor
} from "prosemirror-gapcursor"
import {
    buildKeymap
} from "prosemirror-example-setup"
import {
    jumpHiddenNodesPlugin,
    searchPlugin,
    clipboardPlugin
} from "../state_plugins"
import {
    buildEditorKeymap
} from "../keymap"
import { 
    BIBLIOGRAPHY_HEADERS
} from "../../schema/i18n"
import {
    RenderCitations
} from "../../citations/render"
import {
    mergeHelpTemplate
} from "../dialogs/merge"

export class Merge{
    constructor(mod){
        this.mod = mod
        this.trackOfflineLimit = 50// Limit of local changes while offline for tracking to kick in when multiple users edit
        this.remoteTrackOfflineLimit = 20 // Limit of remote changes while offline for tracking to kick in when multiple users edit
        this.mergeDialog = false
        this.mergeView1 = false
        this.mergeView2 = false
        this.mergeView3 = false
        this.mergedDocMap = false
        this.offlineTr = false
        this.onlineTr = false
        this.diffPlugin = [
            [diffPlugin,()=>({editor:this.mod.editor})],
            [keymap, () => buildEditorKeymap(this.mod.editor.schema)],
            [keymap, () => buildKeymap(this.mod.editor.schema)],
            [keymap, () => baseKeymap],
            [collab, () => ({clientID: this.mod.editor.client_id})],
            [history],
            [dropCursor],
            [gapCursor],
            [tableEditing],
            [jumpHiddenNodesPlugin],
            [searchPlugin],
            [clipboardPlugin, () => ({editor: this.mod.editor, viewType: 'main'})]
        ]
    }

    trDoc(tr, index = 0) {
        return tr.docs.length > index ? tr.docs[index] : tr.doc
    }

    findConflicts(tr1, tr2) {
        let changes1 , changes2 , conflicts = []
        changes1 = this.findContentChanges(tr1)
        changes2 = this.findContentChanges(tr2)
        
        console.log("Changes1",JSON.parse(JSON.stringify(changes1)))
        console.log("Changes2",JSON.parse(JSON.stringify(changes2)))

        changes1.deletedsteps.forEach(deleted => {
            changes2.insertedsteps.forEach(inserted => {
                if (inserted.pos >= deleted.from && inserted.pos <= deleted.to) {
                    conflicts.push([deleted.data.step,"deletion",inserted.data.step,"insertion"])
                }
            })
        })

        changes2.deletedsteps.forEach(deleted => {
            changes1.insertedsteps.forEach(inserted => {
                if (inserted.pos >= deleted.from && inserted.pos <= deleted.to) {
                    conflicts.push([inserted.data.step,"insertion",deleted.data.step,"deletion"])
                }
            })
        })
        return conflicts
    }

    findContentChanges(tr) {
        const doc = this.trDoc(tr)
        let changes = ChangeSet.create(doc)
        tr.steps.forEach((step, index) => {
            const doc = this.trDoc(tr, index + 1)
            changes = changes.addSteps(doc, [tr.mapping.maps[index]], {step: index})
        })
        const invertedMapping = new Mapping()
        invertedMapping.appendMappingInverted(tr.mapping)

        const insertedsteps = [] , deletedsteps = [] ,ins = [],del = []
        changes.changes.forEach(change=>{
            change.inserted.forEach(inserted=>{
                if(!ins.includes(inserted.data.step)){
                    insertedsteps.push({pos: invertedMapping.map(change.fromB), data: inserted.data })
                    ins.push(inserted.data.step)
                }
            })
            change.deleted.forEach(deleted=>{
                if(!del.includes(deleted.data.step)){
                    del.push(deleted.data.step)
                    deletedsteps.push({from: change.fromA, to: change.toA, data: deleted.data})
                }
            })
        })
        return {insertedsteps, deletedsteps}
    }

    changeSet(tr){
        const doc = this.trDoc(tr)
        let changes = ChangeSet.create(doc)
        tr.steps.forEach((step, index) => {
            const doc = this.trDoc(tr, index + 1)
            changes = changes.addSteps(doc, [tr.mapping.maps[index]], {step: index})
        })
        console.log("CHANGES",changes)
        return changes
    }

    updateDB(doc,data){
        const usedImages = [],
            usedBibs = []
        const footnoteFind = (node, usedImages, usedBibs) => {
            if (node.name==='citation') {
                node.attrs.references.forEach(ref => usedBibs.push(parseInt(ref.id)))
            } else if (node.name==='figure' && node.attrs.image) {
                usedImages.push(node.attrs.image)
            } else if (node.content) {
                node.content.forEach(subNode => footnoteFind(subNode, usedImages, usedBibs))
            }
        }

        // Looking at rebased doc so that it contains the merged document !!!
        doc.descendants(node => {
            if (node.type.name==='citation') {
                node.attrs.references.forEach(ref => usedBibs.push(parseInt(ref.id)))
            } else if (node.type.name==='figure' && node.attrs.image) {
                usedImages.push(node.attrs.image)
            } else if (node.type.name==='footnote' && node.attrs.footnote) {
                node.attrs.footnote.forEach(subNode => footnoteFind(subNode, usedImages, usedBibs))
            }
        })
        
        const oldBibDB = this.mod.editor.mod.db.bibDB.db
        this.mod.editor.mod.db.bibDB.setDB(data.doc.bibliography)
        usedBibs.forEach(id => {
            if (!this.mod.editor.mod.db.bibDB.db[id] && oldBibDB[id]) {
                this.mod.editor.mod.db.bibDB.updateReference(id, oldBibDB[id])
            }
        })
        const oldImageDB = this.mod.editor.mod.db.imageDB.db
        this.mod.editor.mod.db.imageDB.setDB(data.doc.images)
        usedImages.forEach(id => {
            if (!this.mod.editor.mod.db.imageDB.db[id] && oldImageDB[id]) {
                // If the image was uploaded by the offline user we know that he may not have deleted it so we can resend it normally
                if(Object.keys(this.mod.editor.app.imageDB.db).includes(
                    String(id))){
                    this.mod.editor.mod.db.imageDB.setImage(id, oldImageDB[id])
                } else {
                    // If the image was uploaded by someone else , to set the image we have to reupload it again as there is backend check to associate who can add an image with the image owner.
                    this.mod.editor.mod.db.imageDB.reUploadImage(id,oldImageDB[id].image,oldImageDB[id].title,oldImageDB[id].copyright).then(
                        ({id,new_id})=>{
                            // Update the image node if there are any re uploaded images.
                            this.mergeView1.state.doc.descendants((node, pos) => {
                                if (node.type.name==='figure' && node.attrs.image == id) {
                                    const attrs = Object.assign({}, node.attrs)
                                    attrs["image"] = new_id
                                    const nodeType = this.mergeView1.state.schema.nodes['figure']
                                    const transaction = this.mergeView1.state.tr.setNodeMarkup(pos, nodeType, attrs)
                                    this.mergeView1.dispatch(transaction)
                                }
                            })
                            this.mergeView2.state.doc.descendants((node, pos) => {
                                if (node.type.name==='figure' && node.attrs.image == id) {
                                    const attrs = Object.assign({}, node.attrs)
                                    attrs["image"] = new_id
                                    const nodeType = this.mergeView2.state.schema.nodes['figure']
                                    const transaction = this.mergeView2.state.tr.setNodeMarkup(pos, nodeType, attrs)
                                    this.mergeView2.dispatch(transaction)
                                }
                            })
                        }
                    )
                }
            }
        })

    }

    applyChangesToEditor(tr,onlineDoc){
        const OnlineStepsLost = recreateTransform(onlineDoc,this.mod.editor.view.state.doc)
        const conflicts = this.findConflicts(tr,OnlineStepsLost)
        if(conflicts.length>0){
            this.openDiffEditors(onlineDoc,tr.doc,OnlineStepsLost.doc,tr,OnlineStepsLost)
        } else {
            const newTr = this.mod.editor.view.state.tr
            const maps = new Mapping([].concat(tr.mapping.maps.slice().reverse().map(map=>map.invert())).concat(OnlineStepsLost.mapping.maps))
            tr.steps.forEach((step,index)=>{
                const mapped = step.map(maps.slice(tr.steps.length - index))
                if (mapped && !newTr.maybeStep(mapped).failed) {
                    maps.appendMap(mapped.getMap())
                    maps.setMirror(tr.steps.length-index-1,(tr.steps.length+OnlineStepsLost.steps.length+newTr.steps.length-1))
                }
            })
            newTr.setMeta('remote',true)
            this.mod.editor.view.dispatch(newTr)
            this.mod.editor.mod.footnotes.fnEditor.renderAllFootnotes()
        }        
    }

    findNotTrackedSteps(tr,trackedSteps){
        const nonTrackedSteps = []
        tr.steps.forEach((step,index)=>{
            if(!trackedSteps.includes(index)){
                nonTrackedSteps.push(step)
            }
        })
        return nonTrackedSteps
    }

    markImageDiffs(tr,from,to,difftype,steps_involved){
        tr.doc.nodesBetween(
            from,
            to,
            (node, pos) => {
                if (pos < from || ['bullet_list', 'ordered_list'].includes(node.type.name)) {
                    return true
                } else if (node.isInline || ['table_row', 'table_cell'].includes(node.type.name)) {
                    return false
                }
                if (node.attrs.diffdata) {
                    const diffdata = []
                    diffdata.push({type : difftype , from:from ,to:to , steps:steps_involved})
                    tr.setNodeMarkup(pos, null, Object.assign({}, node.attrs, {diffdata}), node.marks)
                }
                if (node.type.name==='table') {
                    // A table was inserted. We don't add track marks to elements inside of it.
                    return false
                }
            }
        )
    }

    openHelpDialog(){
        const helpDialog = new Dialog({
            id: 'editor-merge-help',
            title: gettext("Frequently Asked Questions"),
            body: mergeHelpTemplate,
            height:600,
            width:900,
            buttons:[]
        })
        helpDialog.open()
        const question_items = document.querySelectorAll('.merge-question .fa-plus-circle')
        question_items.forEach(element=>{
                const answerEle = element.parentNode.nextSibling.nextElementSibling
                answerEle.style.display = "none"
        })
        question_items.forEach(element=>{
            element.addEventListener('click',()=>{
                const answerEle = element.parentNode.nextSibling.nextElementSibling
                if (answerEle.style.display == ""){
                    element.classList.remove("fa-minus-circle")
                    element.classList.add("fa-plus-circle")
                    answerEle.style.display = "none"
                } else if (answerEle.style.display = "none"){
                    element.classList.remove("fa-plus-circle")
                    element.classList.add("fa-minus-circle")
                    answerEle.style.display = ""
                }
            })
        })
    }

    createMergeDialog(offlineTr,onlineTr,onlineDoc){
        const mergeButtons = [{
            text: " Help ",
            classes: 'fw-orange',
            click: () => {
                this.openHelpDialog()
            }
        },{ 
            text: "Merge Complete",
            classes: 'fw-dark',
            click: () => {
                // Remove all diff related marks
                removeMarks( this.mergeView2,0,this.mergeView2.state.doc.content.size ,this.mod.editor.schema.marks.DiffMark )

                // Apply all the marks that are not handled by recreate steps!
                const markTr = this.mergeView2.state.tr
                const onlineMaps = onlineTr.mapping.maps.slice().reverse().map(map=>map.invert())
                const onlineRebaseMapping = new Mapping(onlineMaps)
                onlineRebaseMapping.appendMapping(this.mergedDocMap)
                this.onStepsNotTracked.forEach(markstep=>{
                    const stepIndex = parseInt(onlineTr.steps.indexOf(markstep))
                    const onlineRebaseMap = onlineRebaseMapping.slice(onlineTr.steps.length-stepIndex)
                    const mappedMarkStep = markstep.map(onlineRebaseMap)
                    if(mappedMarkStep && !markTr.maybeStep(mappedMarkStep).failed){
                        this.mergedDocMap.appendMap(mappedMarkStep.getMap())
                        onlineRebaseMapping.appendMap(mappedMarkStep.getMap())
                        onlineRebaseMapping.setMirror(onlineTr.steps.length-stepIndex-1,(onlineTr.steps.length+this.mergedDocMap.maps.length-1))    
                    }
                })
                const offlineRebaseMapping = new Mapping()
                offlineRebaseMapping.appendMappingInverted(offlineTr.mapping)
                offlineRebaseMapping.appendMapping(this.mergedDocMap)
                this.offStepsNotTracked.forEach(markstep=>{
                    const stepIndex = offlineTr.steps.indexOf(markstep)
                    const offlineRebaseMap = offlineRebaseMapping.slice(offlineTr.steps.length-stepIndex)
                    const mappedMarkStep = markstep.map(offlineRebaseMap)
                    if(mappedMarkStep && !markTr.maybeStep(mappedMarkStep).failed){
                        this.mergedDocMap.appendMap(mappedMarkStep.getMap())
                        offlineRebaseMapping.appendMap(mappedMarkStep.getMap())
                        offlineRebaseMapping.setMirror(offlineTr.steps.length-stepIndex-1,(offlineTr.steps.length+this.mergedDocMap.maps.length-1))    
                    } 
                })
                this.mergeView2.dispatch(markTr)
                
                
                this.mergeDialog.close()
                const mergedDoc = this.mergeView2.state.doc
                //CleanUp
                this.mergeView1.destroy()
                this.mergeView2.destroy()
                this.mergeView3.destroy()
                this.mergeView1 = false
                this.mergeView2 = false
                this.mergeView3 = false
                this.mergedDocMap = false
                this.mergeDialog = false
                this.offlineMarkSteps = false
                this.onlineMarkSteps = false
                this.Dep = false
                this.offStepsNotTracked = false
                this.onStepsNotTracked = false
    
                this.applyChangesToEditor(recreateTransform(onlineDoc,mergedDoc),onlineDoc)
            }
        }]
        const dialog = new Dialog({
            id: 'editor-merge-view',
            title: gettext("Merging Offline Document"),
            body: `<div style="display:flex"><div class="offline-heading">OFFLINE DOCUMENT</div><div class="merged-heading">MERGED DOCUMENT</div> <div class="online-heading">ONLINE DOCUMENT</div></div><div class= "user-contents" style="display:flex;"><div id="editor-diff-1" style="float:left;padding:15px;"></div><div id="editor-diff" class="merged-view" style="padding:15px;"></div><div id="editor-diff-2" style="float:right;padding:15px;"></div></div><div class="help-note"> Note : If this is your first time encountering this dialog please read the instructions for merging by clicking on the Help button.</div>`,
            height:600,
            width:window.innerwidth,
            buttons:mergeButtons
        })
        return dialog
    }

    updateMarkData(tr){
        // Update the range inside the marks !!
        const initialdiffMap = tr.getMeta('initialDiffMap')
        if(!initialdiffMap && (tr.steps.length>0 || tr.docChanged)){
            tr.doc.nodesBetween(
                0,
                tr.doc.content.size,
                (node, pos) => {
                    if (['bullet_list', 'ordered_list'].includes(node.type.name)) {
                        return true
                    } else if (['table_row', 'table_cell'].includes(node.type.name)) {
                        return false
                    } else if (node.isInline){
                        let diffMark = node.marks.find(mark=>mark.type.name=="DiffMark")
                        if(diffMark!== undefined){
                            diffMark = JSON.parse(JSON.stringify(diffMark.attrs))
                            tr.removeMark(pos,pos+node.nodeSize,this.mod.editor.schema.marks.DiffMark)
                            const mark = this.mod.editor.schema.marks.DiffMark.create({diff:diffMark.diff,steps:diffMark.steps,from:tr.mapping.map(diffMark.from),to:tr.mapping.map(diffMark.to)})
                            tr.addMark(pos,pos+node.nodeSize,mark)
                        }
                    }
                    if (node.attrs.diffdata && node.attrs.diffdata.length>0) {
                        const diffdata = node.attrs.diffdata
                        diffdata[0].from = tr.mapping.map(diffdata[0].from)
                        diffdata[0].to = tr.mapping.map(diffdata[0].to)
                        tr.setNodeMarkup(pos, null, Object.assign({}, node.attrs, {diffdata}), node.marks)
                    }
                    if (node.type.name==='table') {
                        return false
                    }
                }
            )
        }
        return tr
    }

    bindEditorView(elementId,doc){
        const editor = this.mod.editor
        // Bind the plugins to the respective views
        let orignal_plugins = this.mod.editor.statePlugins
        orignal_plugins = orignal_plugins.filter((plugin,pos)=>pos!=16)
        const plugins = this.diffPlugin.map(plugin=>{
            if (plugin[1]) {
                return plugin[0](plugin[1](doc))
            } else {
                return plugin[0]()
            }
        })
        let editorView
        if(elementId == "editor-diff"){
            editorView = new EditorView(document.getElementById(elementId), {
                state: EditorState.create({
                    schema: this.mod.editor.schema,
                    doc: doc,
                    plugins:plugins,
                }),
                dispatchTransaction: tr => {
                    const mapTracked = tr.getMeta('mapTracked')
                    const notTrack = tr.getMeta('notrack')
                    if(!mapTracked)
                        this.mergedDocMap.appendMapping(tr.mapping)
                    let mapTr = this.updateMarkData(tr)
                    if(!notTrack){ // Track only manual insertions
                        mapTr = trackedTransaction(
                            mapTr,
                            this.mergeView2.state,
                            this.mod.editor.user,
                            !this.mergeView2.state.doc.firstChild.attrs.tracked && this.mod.editor.docInfo.access_rights !== 'write-tracked',
                            Date.now() - this.mod.editor.clientTimeAdjustment
                        )
                    }
                    const newState = editorView.state.apply(mapTr)
                    editorView.updateState(newState)
                    this.renderCitation(editorView,elementId)
                },
                nodeViews: {
                    footnote(node, view, getPos ) { return new FootnoteView(node, view, getPos ,editor) }
                }
            })

        } else {
            editorView = new EditorView(document.getElementById(elementId), {
                state: EditorState.create({
                    schema: this.mod.editor.schema,
                    doc: doc,
                    plugins:plugins,
                }),
                dispatchTransaction: tr => {
                    const mapTr = this.updateMarkData(tr)
                    const newState = editorView.state.apply(mapTr)
                    editorView.updateState(newState)
                    this.renderCitation(editorView,elementId)
                },
                nodeViews: {
                    footnote(node, view, getPos ) { return new FootnoteView(node, view, getPos ,editor) }
                }
            })
        }
        return editorView 
    }

    markChangesinDiffEditor(changeset,insertionView,deletionView,insertionClass,deletionClass,tr,trType){
        // Mark the insertions in insertion View & deletions in deletionView
        const insertionMarksTr = insertionView.state.tr
        const deletionMarksTr = deletionView.state.tr
        let stepsTrackedByChangeset = []
        // Use the changeset to create the marks
        changeset.changes.forEach(change=>{
            if(change.inserted.length>0){
                let steps_involved = []
                change.inserted.forEach(insertion=>steps_involved.push(parseInt(insertion.data.step)))
                const stepsSet = new Set(steps_involved)
                steps_involved = Array.from(stepsSet)
                
                // Add the footnote related steps because the changeset tracks change but misses some steps related to insertion of footnote node!
                tr.steps.forEach((step,index)=>{
                    if(step.from >= change.fromB && step.to<=change.toB && step instanceof ReplaceStep && !steps_involved.includes(index)){
                        const Step1 = step.toJSON()
                        if(Step1.slice && Step1.slice.content.length == 1 && Step1.slice.content[0].type === "footnote"){
                            steps_involved.push(index)
                        }
                    } else if (step.from >= change.fromB && step.to<=change.toB && step instanceof AddMarkStep && !steps_involved.includes(index)){
                        const Step1 = step.toJSON()
                        if(Step1.mark && ["strong","em","underline","link","deletion","insertion","comment"].includes(Step1.mark.type)){
                            steps_involved.push(index)
                        } 
                    }
                })

                steps_involved.sort((a,b)=>a-b)
                const insertionMark = this.mod.editor.schema.marks.DiffMark.create({diff:insertionClass,steps:JSON.stringify(steps_involved),from:change.fromB,to:change.toB})
                insertionMarksTr.addMark(change.fromB,change.toB,insertionMark)
                this.markImageDiffs(insertionMarksTr,change.fromB,change.toB,insertionClass,steps_involved)
                stepsTrackedByChangeset=stepsTrackedByChangeset.concat(steps_involved)
            } if (change.deleted.length>0){
                let steps_involved = []
                change.deleted.forEach(deletion=>steps_involved.push(parseInt(deletion.data.step)))
                const stepsSet = new Set(steps_involved)
                steps_involved = Array.from(stepsSet)
                steps_involved.sort((a,b)=>a-b)
                const deletionMark = this.mod.editor.schema.marks.DiffMark.create({diff:deletionClass,steps:JSON.stringify(steps_involved),from:change.fromA,to:change.toA})
                deletionMarksTr.addMark(change.fromA,change.toA,deletionMark)
                this.markImageDiffs(deletionMarksTr,change.fromA,change.toA,deletionClass,steps_involved)
                stepsTrackedByChangeset=stepsTrackedByChangeset.concat(steps_involved)
            }
        })


        // Add all the footnote/mark/citation related steps that are not tracked by changeset!!!!!
        tr.steps.forEach((step,index)=>{
            const from = tr.mapping.slice(index).map(step.from)
            const to = tr.mapping.slice(index).map(step.to,-1)
            if(step instanceof ReplaceStep && !stepsTrackedByChangeset.includes(index)){
                const Step1 = step.toJSON()
                if(Step1.slice && Step1.slice.content.length == 1 && Step1.slice.content[0].type === "footnote"){
                    const insertionMark = this.mod.editor.schema.marks.DiffMark.create({diff:insertionClass,steps:JSON.stringify([index]),from:from,to:to})
                    insertionMarksTr.addMark(from,to,insertionMark)
                    stepsTrackedByChangeset.push(index)
                } else if(Step1.slice && Step1.slice.content.length == 1 && Step1.slice.content[0].type === "citation"){
                    const insertionMark = this.mod.editor.schema.marks.DiffMark.create({diff:insertionClass,steps:JSON.stringify([index]),from:from,to:to})
                    insertionMarksTr.addMark(from,to,insertionMark)
                    stepsTrackedByChangeset.push(index)
                }
            } 
            else if ((step instanceof AddMarkStep || step instanceof RemoveMarkStep ) && !stepsTrackedByChangeset.includes(index)){
                const Step1 = step.toJSON()
                if(Step1.mark && ["strong","em","underline","link","deletion","insertion"].includes(Step1.mark.type)){
                    if(step instanceof AddMarkStep){
                        const insertionMark = this.mod.editor.schema.marks.DiffMark.create({diff:insertionClass,steps:JSON.stringify([index]),from:from,to:to})
                        stepsTrackedByChangeset.push(index)
                        if(insertionMarksTr.doc.rangeHasMark(from,to,insertionMark.type)){
                            let steps = []
                            insertionMarksTr.doc.nodesBetween(from,to,(node,pos)=>{
                                if (['bullet_list', 'ordered_list'].includes(node.type.name)) {
                                    return true
                                } else if (['table_row', 'table_cell'].includes(node.type.name)) {
                                    return false
                                } else if (node.isInline){
                                    let diffMark = node.marks.find(mark=>mark.type.name=="DiffMark")
                                    if(diffMark!== undefined){
                                        diffMark = JSON.parse(JSON.stringify(diffMark.attrs))
                                        steps = steps.concat(JSON.parse(diffMark.steps))
                                    }
                                }
                                if (node.attrs.diffdata && node.attrs.diffdata.length>0) {
                                    const diffdata = JSON.parse(node.attrs.diffdata)
                                    steps = steps.concat(diffdata[0].steps)
                                }
                                if (node.type.name==='table') {
                                    return false
                                }
                            })
                            const stepsSet = new Set(steps)
                            steps = Array.from(stepsSet)
                            this.Dep[trType][index] = steps
                        } else {
                            insertionMarksTr.addMark(from,to,insertionMark)
                        }
                    } else if (step instanceof RemoveMarkStep && Step1.mark.type !== "insertion") {
                        const deletionMark = this.mod.editor.schema.marks.DiffMark.create({diff:deletionClass,steps:JSON.stringify([index]),from:from,to:to})
                        deletionMarksTr.addMark(from,to,deletionMark)
                        stepsTrackedByChangeset.push(index)
                    }
                } 
            }
        })

        // Dispatch the transactions
        insertionMarksTr.setMeta('initialDiffMap',true).setMeta('mapTracked',true)
        deletionMarksTr.setMeta('initialDiffMap',true).setMeta('mapTracked',true)
        insertionView.dispatch(insertionMarksTr)
        deletionView.dispatch(deletionMarksTr)

        //Return steps that are tracked in the diff editor
        return stepsTrackedByChangeset
    }

    renderCitation(view,elementId){
        const settings = view.state.doc.firstChild.attrs,
        bibliographyHeader = settings.bibliography_header[settings.language] || BIBLIOGRAPHY_HEADERS[settings.language]
        const citRenderer = new RenderCitations(
            document.getElementById(elementId),
            settings.citationstyle,
            bibliographyHeader,
            this.mod.editor.mod.db.bibDB,
            this.mod.editor.app.csl
        )
        citRenderer.init()
    }

    openDiffEditors(cpDoc,offlineDoc,onlineDoc,offlineTr,onlineTr){
        this.mergeDialog  = this.createMergeDialog(offlineTr,onlineTr,onlineDoc)
        this.mergeDialog.open()
        this.offlineTr = offlineTr
        this.onlineTr = onlineTr
        this.Dep = {}
        this.Dep['online'] = {}
        this.Dep['offline'] = {}
        console.log("ONLINE",onlineTr)
        console.log("OFFLINE",offlineTr)

        this.mergedDocMap = new Mapping()
        // Create multiple editor views
        this.mergeView1 = this.bindEditorView('editor-diff-1',offlineDoc)
        this.mergeView2 = this.bindEditorView('editor-diff',cpDoc)
        this.mergeView3 = this.bindEditorView('editor-diff-2',onlineDoc)
        
        const offlineChangeset = this.changeSet(offlineTr)
        const onlineChangeset = this.changeSet(onlineTr)

        const offlineTrackedSteps = this.markChangesinDiffEditor(offlineChangeset,this.mergeView1,this.mergeView2,"offline-inserted","offline-deleted",offlineTr,"offline")
        const onlineTrackedSteps = this.markChangesinDiffEditor(onlineChangeset,this.mergeView3,this.mergeView2,"online-inserted","online-deleted",onlineTr,"online")

        if(this.mergeView1.state.doc.firstChild.attrs.tracked || this.mergeView3.state.doc.firstChild.attrs.tracked ){
            const article = this.mergeView2.state.doc.firstChild
            const attrs = Object.assign({}, article.attrs)
            attrs.tracked = true
            this.mergeView2.dispatch(
                this.mergeView2.state.tr.setNodeMarkup(0, false, attrs).setMeta('notrack',true).setMeta('mapTracked',true)
            )
        }

        this.renderCitation(this.mergeView1,'editor-diff-1')
        this.renderCitation(this.mergeView2,'editor-diff')
        this.renderCitation(this.mergeView3,'editor-diff-2')

        this.offStepsNotTracked = this.findNotTrackedSteps(offlineTr,offlineTrackedSteps)
        this.onStepsNotTracked = this.findNotTrackedSteps(onlineTr,onlineTrackedSteps)
    }

    diffMerge(cpDoc,offlineDoc,onlineDoc,offlineTr,onlineTr,data){
        // Update the Bib and image DB before hand with the data from the offline document and the socket data.
        this.openDiffEditors(cpDoc,offlineDoc,onlineDoc,offlineTr,onlineTr)
        this.updateDB(offlineDoc,data) // Updating the editor DB is one-time operation.
    }

    autoMerge(unconfirmedTr,lostTr,data){
        const toDoc = this.mod.editor.schema.nodeFromJSON({type:'doc', content:[
            data.doc.contents
        ]})
        const rebasedTr = EditorState.create({doc: toDoc}).tr.setMeta('remote', true)
        const maps = new Mapping([].concat(unconfirmedTr.mapping.maps.slice().reverse().map(map=>map.invert())).concat(lostTr.mapping.maps.slice()))

        unconfirmedTr.steps.forEach(
            (step, index) => {
                const mapped = step.map(maps.slice(unconfirmedTr.steps.length - index))
                if (mapped && !rebasedTr.maybeStep(mapped).failed) {
                    maps.appendMap(mapped.getMap())
                    maps.setMirror(unconfirmedTr.steps.length-index-1, (unconfirmedTr.steps.length+lostTr.steps.length+rebasedTr.steps.length-1))
                }
            }
        )

        let tracked
        let rebasedTrackedTr // offline steps to be tracked
        if (
            ['write', 'write-tracked'].includes(this.mod.editor.docInfo.access_rights) &&
            (
                unconfirmedTr.steps.length > this.trackOfflineLimit ||
                lostTr.steps.length > this.remoteTrackOfflineLimit
            )
        ) {
            tracked = true
            // Either this user has made 50 changes since going offline,
            // or the document has 20 changes to it. Therefore we add tracking
            // to the changes of this user and ask user to clean up.
            rebasedTrackedTr = trackedTransaction(
                rebasedTr,
                this.mod.editor.view.state,
                this.mod.editor.user,
                false,
                Date.now() - this.mod.editor.clientTimeAdjustment
            )
        } else {
            tracked = false
            rebasedTrackedTr = rebasedTr
        }

        let usedImages = []
        const usedBibs = []
        const footnoteFind = (node, usedImages, usedBibs) => {
            if (node.name==='citation') {
                node.attrs.references.forEach(ref => usedBibs.push(parseInt(ref.id)))
            } else if (node.name==='figure' && node.attrs.image) {
                usedImages.push(node.attrs.image)
            } else if (node.content) {
                node.content.forEach(subNode => footnoteFind(subNode, usedImages, usedBibs))
            }
        }
        rebasedTr.doc.descendants(node => {
            if (node.type.name==='citation') {
                node.attrs.references.forEach(ref => usedBibs.push(parseInt(ref.id)))
            } else if (node.type.name==='figure' && node.attrs.image) {
                usedImages.push(node.attrs.image)
            } else if (node.type.name==='footnote' && node.attrs.footnote) {
                node.attrs.footnote.forEach(subNode => footnoteFind(subNode, usedImages, usedBibs))
            }
        })
        const oldBibDB = this.mod.editor.mod.db.bibDB.db
        this.mod.editor.mod.db.bibDB.setDB(data.doc.bibliography)
        usedBibs.forEach(id => {
            if (!this.mod.editor.mod.db.bibDB.db[id] && oldBibDB[id]) {
                this.mod.editor.mod.db.bibDB.updateReference(id, oldBibDB[id])
            }
        })
        const oldImageDB = this.mod.editor.mod.db.imageDB.db
        this.mod.editor.mod.db.imageDB.setDB(data.doc.images)
        // Remove the Duplicated image ID's
        usedImages = new Set(usedImages)
        usedImages = Array.from(usedImages)
        usedImages.forEach(id => {
            if (!this.mod.editor.mod.db.imageDB.db[id] && oldImageDB[id]) {
                // If the image was uploaded by the offline user we know that he may not have deleted it so we can resend it normally
                if (Object.keys(this.mod.editor.app.imageDB.db).includes(id)) {
                    this.mod.editor.mod.db.imageDB.setImage(id, oldImageDB[id])
                } else {
                    // If the image was uploaded by someone else , to set the image we have to reupload it again as there is backend check to associate who can add an image with the image owner.
                    this.mod.editor.mod.db.imageDB.reUploadImage(id, oldImageDB[id].image, oldImageDB[id].title, oldImageDB[id].copyright)
                }
            }
        })

        // this.mod.editor.docInfo.version = data.doc.v
        rebasedTrackedTr.setMeta('remote', true)
        this.mod.editor.view.dispatch(rebasedTrackedTr)

        if (tracked) {
            showSystemMessage(
                gettext(
                    'The document was modified substantially by other users while you were offline. We have merged your changes in as tracked changes. You should verify that your edits still make sense.'
                )
            )
        }
        this.mod.editor.mod.footnotes.fnEditor.renderAllFootnotes()
        
    }

}