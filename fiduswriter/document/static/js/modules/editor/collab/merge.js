
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
    RemoveMarkStep
} from "prosemirror-transform"
import {
    showSystemMessage,
    Dialog,
    addAlert
} from "../../common"
import {
    recreateTransform
} from "./recreate_transform"
import {
    trackedTransaction
} from "../track"


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

        console.log("HEY",changes)
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
        return changes
    }

    applyChangesToEditor(tr,data,onlineDoc){
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
        tr.doc.descendants(node => {
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
                if(Object.keys(this.mod.editor.app.imageDB.db).includes(id)){
                    this.mod.editor.mod.db.imageDB.setImage(id, oldImageDB[id])
                } else {
                    // If the image was uploaded by someone else , to set the image we have to reupload it again as there is backend check to associate who can add an image with the image owner.
                    this.mod.editor.mod.db.imageDB.reUploadImage(id,oldImageDB[id].image,oldImageDB[id].title,oldImageDB[id].copyright)
                }
            }
        })

        const OnlineStepsLost = recreateTransform(onlineDoc,this.mod.editor.view.state.doc)
        const newTr = this.mod.editor.view.state.tr
        const maps = new Mapping([].concat(tr.mapping.maps.slice().reverse().map(map=>map.invert())).concat(OnlineStepsLost.mapping.maps))
        tr.steps.forEach((step,index)=>{
            const mapped = step.map(maps.slice(tr.steps.length - index))
            if (mapped && !newTr.maybeStep(mapped).failed) {
                maps.appendMap(mapped.getMap())
                maps.setMirror(tr.steps.length-index-1,(tr.steps.length+OnlineStepsLost.steps.length+newTr.steps.length-1))
            }
        })
        this.mod.editor.view.dispatch(newTr)        
    }

    findMarkSteps(tr,changeset){
        const markSteps = []
        tr.steps.forEach(step=>{
            if(step instanceof AddMarkStep || step instanceof RemoveMarkStep){
                markSteps.push(step)
            }
        })
        const stepsMean = []
        changeset.changes.forEach(change=>{
            if(change.inserted.length>0){
                markSteps.forEach(markstep=>{
                    const mappedMarkStep = markstep.map(tr.mapping.slice(tr.steps.indexOf(markstep),tr.steps.length))
                    if(!(mappedMarkStep.from>=change.fromB &&mappedMarkStep.to<=change.toB)){
                        stepsMean.push(markstep)
                    }
                })
            }
        })
        return stepsMean
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
                if (node.attrs.diffData && node.type.name == "figure") {
                    const diffData = []
                    diffData.push({type : difftype , from:from ,to:to , steps:steps_involved})
                    const diff = difftype
                    console.log("Wohooo",Object.assign({}, node.attrs, {diffData,diff}))
                    tr.setNodeMarkup(pos, null, Object.assign({}, node.attrs, {diffData,diff}), node.marks)
                }
                if (node.type.name==='table') {
                    // A table was inserted. We don't add track marks to elements inside of it.
                    return false
                }
            }
        )
    }

    removeFigureMarks(view,from,to){
        const tr = view.state.tr
        tr.doc.nodesBetween(
            from,
            to,
            (node, pos) => {
                if (pos < from || ['bullet_list', 'ordered_list'].includes(node.type.name)) {
                    return true
                } else if (node.isInline || ['table_row', 'table_cell'].includes(node.type.name)) {
                    return false
                }
                if (node.attrs.diffData && node.type.name == "figure") {
                    const diffData = []
                    const diff = ""
                    console.log("Wohooo2",Object.assign({}, node.attrs, {diffData,diff}))
                    tr.setNodeMarkup(pos, null, Object.assign({}, node.attrs, {diffData,diff}), node.marks)
                }
                if (node.type.name==='table') {
                    // A table was inserted. We don't add track marks to elements inside of it.
                    return false
                }
            }
        )
        view.dispatch(tr)
    }

    createMergeDialog(offlineTr,onlineTr,onlineDoc,data){
        const mergeButtons = [{ 
            text: "Merge Complete",
            classes: 'fw-dark',
            click: () => {
                // Remove all diff related marks
                const DiffRemovalTr = this.mergeView2.state.tr
                DiffRemovalTr.removeMark(0,this.mergeView2.state.doc.content.size,this.mod.editor.schema.marks.DiffMark)
                this.mergeView2.dispatch(DiffRemovalTr)
                
                // Apply all the marks that are not handled by recreate steps!
                const markTr = this.mergeView2.state.tr
                const offlineRebaseMapping = new Mapping()
                offlineRebaseMapping.appendMappingInverted(offlineTr.mapping)
                offlineRebaseMapping.appendMapping(this.mergedDocMap)
                this.offlineMarkSteps.forEach(markstep=>{
                    const offlineRebaseMap = offlineRebaseMapping.slice(offlineTr.steps.indexOf(markstep))
                    const mappedMarkStep = markstep.map(offlineRebaseMap)
                    if(mappedMarkStep){
                        markTr.step(mappedMarkStep)
                    } 
                })
                const onlineRebaseMapping = new Mapping()
                onlineRebaseMapping.appendMappingInverted(onlineTr.mapping)
                onlineRebaseMapping.appendMapping(this.mergedDocMap)
                this.onlineMarkSteps.forEach(markstep=>{
                    const onlineRebaseMap = onlineRebaseMapping.slice(onlineTr.steps.indexOf(markstep))
                    const mappedMarkStep = markstep.map(onlineRebaseMap)
                    if(mappedMarkStep){
                        markTr.step(mappedMarkStep)
                    }
                })
                console.log(markTr)
                this.mergeView2.dispatch(markTr)
                
                this.applyChangesToEditor(recreateTransform(onlineDoc,this.mergeView2.state.doc),data,onlineDoc)
                this.mergeDialog.close()

                //CleanUp
                this.mergeView1 = false
                this.mergeView2 = false
                this.mergeView3 = false
                this.mergedDocMap = false
                this.mergeDialog = false
            }
        }]
        const dialog = new Dialog({
            id: 'editor-merge-view',
            title: gettext("Merging Offline Document"),
            body: `<div class= "user-contents" style="display:flex;"><div id="editor-diff-1" style="float:left;padding:15px;"></div><div id="editor-diff" style="padding:15px;"></div><div id="editor-diff-2" style="float:right;padding:15px;"></div></div>`,
            height:500,
            width:1400,
            buttons:mergeButtons
        })
        return dialog
    }

    bindEditorView(elementId,doc){
        // Bind the plugins to the respective views
        const plugins = this.mod.editor.statePlugins.map(plugin => {
            if (plugin[1]) {
                return plugin[0](plugin[1](doc))
            } else {
                return plugin[0]()
            }
        })

        const editorView = new EditorView(document.getElementById(elementId), {
            state: EditorState.create({
                schema: this.mod.editor.schema,
                doc: doc,
                plugins:plugins,
            }),
            dispatchTransaction: tr => {
                const newState = editorView.state.apply(tr)
                editorView.updateState(newState)
            }
        })

        return editorView 

    }

    markChangesinDiffEditor(changeset,insertionView,deletionView,insertionClass,deletionClass){

        // Mark the insertions in insertion View & deletions in deletionView
        const insertionMarksTr = insertionView.state.tr
        const deletionMarksTr = deletionView.state.tr

        // Use the changeset to create the marks
        changeset.changes.forEach(change=>{
            if(change.inserted.length>0){
                let steps_involved = []
                change.inserted.forEach(insertion=>steps_involved.push(insertion.data.step))
                const stepsSet = new Set(steps_involved)
                steps_involved = Array.from(stepsSet)
                steps_involved.sort()
                const insertionMark = this.mod.editor.schema.marks.DiffMark.create({diff:insertionClass,steps:JSON.stringify(steps_involved),from:change.fromB,to:change.toB})
                insertionMarksTr.addMark(change.fromB,change.toB,insertionMark)
                this.markImageDiffs(insertionMarksTr,change.fromB,change.toB,insertionClass,steps_involved)
            } if (change.deleted.length>0){
                const steps_involved = []
                change.deleted.forEach(deletion=>steps_involved.push(deletion.data.step))
                const deletionMark = this.mod.editor.schema.marks.DiffMark.create({diff:deletionClass,steps:JSON.stringify(steps_involved),from:change.fromA,to:change.toA})
                deletionMarksTr.addMark(change.fromA,change.toA,deletionMark)
                this.markImageDiffs(deletionMarksTr,change.fromA,change.toA,deletionClass,steps_involved)
            }
        })

        // Dispatch the transactions
        insertionView.dispatch(insertionMarksTr)
        deletionView.dispatch(deletionMarksTr)
    }

    removeMarks(view,from,to,mark){
        const trackedTr = view.state.tr
        trackedTr.removeMark(from,to,mark)
        view.dispatch(trackedTr)
    }

    bindEventListener(elements,mergeView,originalView,tr){
        for(let element of elements){
            element.addEventListener("click",()=>{
                addAlert('info', `${gettext('Printing has been initiated.')}`)
                const insertionTr = mergeView.state.tr
                const from = element.dataset.from
                const to = element.dataset.to
                const steps = JSON.parse(element.dataset.steps)
                let stepMaps = tr.mapping.maps.slice().reverse().map(map=>map.invert())
                let rebasedMapping = new Mapping(stepMaps)
                rebasedMapping.appendMapping(this.mergedDocMap)
                for(let stepIndex of steps){
                    const maps = rebasedMapping.slice(tr.steps.length-stepIndex)
                    const mappedStep = tr.steps[stepIndex].map(maps)
                    if(mappedStep && !insertionTr.maybeStep(mappedStep).failed){
                        this.mergedDocMap.appendMap(mappedStep.getMap())
                        rebasedMapping.appendMap(mappedStep.getMap())
                        rebasedMapping.setMirror(tr.steps.length-stepIndex-1,(tr.steps.length+this.mergedDocMap.maps.length-1))
                    }
                    // Put the proper mark steps back again
                    for(let step of tr.steps){
                        if(step instanceof AddMarkStep || step instanceof RemoveMarkStep){
                            if(step.from>=from && step.to <= to){
                                if(step.map(rebasedMapping)){
                                    insertionTr.maybeStep(step.map(rebasedMapping))
                                }
                            }
                        }
                    }
                }
                mergeView.dispatch(insertionTr)
                
                // Remove the insertion mark!!
                this.removeMarks(originalView,from,to,this.mod.editor.schema.marks.DiffMark)
            })
        }
    }

    bindFigureEventListeners(figureElements,mergeView,originalView,tr){
        for(let figureElement of figureElements){
            figureElement.addEventListener("click",()=>{
                const tra = mergeView.state.tr
                const diffData = JSON.parse(figureElement.dataset.diffData)[0]
                let stepMaps = tr.mapping.maps.slice().reverse().map(map=>map.invert())
                let rebasedMapping = new Mapping(stepMaps)
                rebasedMapping.appendMapping(this.mergedDocMap)
                for(let stepIndex of diffData.steps){
                    const mappedStep = tr.steps[stepIndex].map(rebasedMapping.slice(tr.steps.length-stepIndex))
                    if(mappedStep && !tra.maybeStep(mappedStep).failed){
                        this.mergedDocMap.appendMap(mappedStep.getMap())
                        rebasedMapping.appendMap(mappedStep.getMap())
                        rebasedMapping.setMirror(tr.steps.length-stepIndex-1,(tr.steps.length+this.mergedDocMap.maps.length-1))
                    }
                }
                mergeView.dispatch(tra)
                
                // Remove the insertion mark!!
                this.removeFigureMarks(originalView,diffData.from,diffData.to)
            })
        }


    }

    openDiffEditors(cpDoc,offlineDoc,onlineDoc,offlineTr,onlineTr,data,conflicts){
        // Directly add the new images to the main editor , to display the images properly in diff editors! The editor DB will be replaced later anyhow!
        for(let image_id in data.doc.images){
            if(!Object.keys(this.mod.editor.mod.db.imageDB).includes(image_id)){
                this.mod.editor.mod.db.imageDB.db[image_id]=data.doc.images[image_id]
            }
        }

        this.mergeDialog  = this.createMergeDialog(offlineTr,onlineTr,onlineDoc,data)
        this.mergeDialog.open()

        console.log("ONLINE",onlineTr)
        console.log("OFFLINE",offlineTr)

        // Create multiple editor views
        this.mergeView1 = this.bindEditorView('editor-diff-1',offlineDoc)
        this.mergeView2 = this.bindEditorView('editor-diff',cpDoc)
        this.mergeView3 = this.bindEditorView('editor-diff-2',onlineDoc)
        

        const offlineChangeset = this.changeSet(offlineTr)
        const onlineChangeset = this.changeSet(onlineTr)

        this.markChangesinDiffEditor(offlineChangeset,this.mergeView1,this.mergeView2,"offline-inserted","offline-deleted")
        this.markChangesinDiffEditor(onlineChangeset,this.mergeView3,this.mergeView2,"online-inserted","online-deleted")

        this.offlineMarkSteps = this.findMarkSteps(offlineTr,offlineChangeset)
        this.onlineMarkSteps = this.findMarkSteps(onlineTr,onlineChangeset)
        
        this.mergedDocMap = new Mapping()

        const offlineInsertedElements = document.querySelectorAll("span.offline-inserted")
        this.bindEventListener(offlineInsertedElements,this.mergeView2,this.mergeView1,offlineTr)
        
        const onlineInsertedElements = document.querySelectorAll("span.online-inserted")
        this.bindEventListener(onlineInsertedElements,this.mergeView2,this.mergeView3,onlineTr)

        const offlineDeletedElements = document.querySelectorAll("span.offline-deleted")
        this.bindEventListener(offlineDeletedElements,this.mergeView2,this.mergeView2,offlineTr)
        
        const onlineDeletedElements = document.querySelectorAll("span.online-deleted")
        this.bindEventListener(onlineDeletedElements,this.mergeView2,this.mergeView2,onlineTr)

        const offlineinsertedFigureElements = document.querySelectorAll(`figure[data-diff="offline-inserted"]`)
        this.bindFigureEventListeners(offlineinsertedFigureElements,this.mergeView2,this.mergeView1,offlineTr)
        
        const onlineinsertedFigureElements = document.querySelectorAll(`figure[data-diff="online-inserted"]`)
        this.bindFigureEventListeners(onlineinsertedFigureElements,this.mergeView2,this.mergeView3,onlineTr)

        const onlinedeletedFigureElements = document.querySelectorAll(`figure[data-diff="online-deleted"]`)
        this.bindFigureEventListeners(onlinedeletedFigureElements,this.mergeView2,this.mergeView2,onlineTr)

        const offlinedeletedFigureElements = document.querySelectorAll(`figure[data-diff="offline-deleted"]`)
        this.bindFigureEventListeners(offlinedeletedFigureElements,this.mergeView2,this.mergeView2,offlineTr)
    }

    autoMerge(unconfirmedTr,lostTr,data){
        const rebasedTr = this.mod.editor.view.state.tr
        let maps = new Mapping([].concat(unconfirmedTr.mapping.maps.slice().reverse().map(map=>map.invert())).concat(lostTr.mapping.maps.slice()))
        
        unconfirmedTr.steps.forEach(
            (step, index) => {
                const mapped = step.map(maps.slice(unconfirmedTr.steps.length - index))
                if (mapped && !rebasedTr.maybeStep(mapped).failed) {
                    maps.appendMap(mapped.getMap())
                    maps.setMirror(unconfirmedTr.steps.length-index-1,(unconfirmedTr.steps.length+lostTr.steps.length+rebasedTr.steps.length-1))
                }
            }
        )
        
        // Enable/Disable tracked changes based on some conditions
        let rebasedTrackedTr,tracked
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
            rebasedTrackedTr.setMeta('remote',true)
        } else {
            tracked = false
            rebasedTrackedTr = rebasedTr.setMeta('remote',true)
        }


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
        usedImages.forEach(id => {
            if (!this.mod.editor.mod.db.imageDB.db[id] && oldImageDB[id]) {
                // If the image was uploaded by the offline user we know that he may not have deleted it so we can resend it normally
                if(Object.keys(this.mod.editor.app.imageDB.db).includes(id)){
                    this.mod.editor.mod.db.imageDB.setImage(id, oldImageDB[id])
                } else {
                    // If the image was uploaded by someone else , to set the image we have to reupload it again as there is backend check to associate who can add an image with the image owner.
                    this.mod.editor.mod.db.imageDB.reUploadImage(id,oldImageDB[id].image,oldImageDB[id].title,oldImageDB[id].copyright)

                }
            }
        })

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