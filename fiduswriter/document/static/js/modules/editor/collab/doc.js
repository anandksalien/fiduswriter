import {
    compare
} from "fast-json-patch"
import {
    sendableSteps,
    receiveTransaction
} from "prosemirror-collab"
import {
    Step,
    Mapping,
    Transform,
    StepMap
} from "prosemirror-transform"
import {
    EditorState,Transaction
} from "prosemirror-state"
import {
    getSelectionUpdate,
    removeCollaboratorSelection,
    updateCollaboratorSelection
} from "../state_plugins"
import {
    adjustDocToTemplate
} from "../../document_template"
import {
    showSystemMessage,
    deactivateWait
} from "../../common"
import {
    toMiniJSON
} from "../../schema/mini_json"
import {
    recreateTransform
} from "./recreate_transform"
import {
    trackedTransaction,acceptAll
} from "../track"
import {
    ChangeSet,simplifyChanges
} from 'prosemirror-changeset'

export class ModCollabDoc {
    constructor(mod) {
        mod.doc = this
        this.mod = mod

        this.unconfirmedDiffs = {}
        this.confirmStepsRequestCounter = 0
        this.awaitingDiffResponse = false
        this.receiving = false
        this.currentlyCheckingVersion = false

        this.trackOfflineLimit = 50 // Limit of local changes while offline for tracking to kick in when multiple users edit
        this.remoteTrackOfflineLimit = 20 // Limit of remote changes while offline for tracking to kick in when multiple users edit
    }

    cancelCurrentlyCheckingVersion() {
        this.currentlyCheckingVersion = false
        window.clearTimeout(this.enableCheckVersion)
    }

    checkVersion() {
        this.mod.editor.ws.send(() => {
            if (this.currentlyCheckingVersion | !this.mod.editor.docInfo
                .version) {
                return
            }
            this.currentlyCheckingVersion = true
            this.enableCheckVersion = window.setTimeout(
                () => {
                    this.currentlyCheckingVersion = false
                },
                1000
            )
            if (this.mod.editor.ws.connected) {
                this.disableDiffSending()
            }
            return {
                type: 'check_version',
                v: this.mod.editor.docInfo.version
            }
        })
    }

    disableDiffSending() {
        this.awaitingDiffResponse = true
        // If no answer has been received from the server within 2 seconds,
        // check the version
        this.sendNextDiffTimer = window.setTimeout(
            () => {
                this.awaitingDiffResponse = false
                this.sendToCollaborators()
            },
            8000
        )
    }

    enableDiffSending() {
        window.clearTimeout(this.sendNextDiffTimer)
        this.awaitingDiffResponse = false
        this.sendToCollaborators()
    }

    receiveDocument(data) {
        this.cancelCurrentlyCheckingVersion()
        if (this.mod.editor.docInfo.confirmedDoc) {
            this.adjustDocument(data)
        } else {
            this.loadDocument(data)
        }
    }

    trDoc(tr, index = 0) {
        return tr.docs.length > index ? tr.docs[index] : tr.doc
    }
    
    findConflicts(tr1, tr2) {
        let changes1 , changes2 , conflicts = []
        changes1 = this.findContentChanges(tr1)
        changes2 = this.findContentChanges(tr2)
        
        console.log("Changes1",changes1)
        console.log("Changes2",changes2)

        changes1.deletedsteps.forEach(deleted => {
            changes2.insertedsteps.forEach(inserted => {
                if (inserted.pos >= deleted.from && inserted.pos <= deleted.to) {
                    if(!conflicts.includes([deleted.data.step,"deletion",inserted.data.step,"insertion"]))
                    conflicts.push([deleted.data.step,"deletion",inserted.data.step,"insertion"])
                }
            })
        })
    
        changes2.deletedsteps.forEach(deleted => {
            changes1.insertedsteps.forEach(inserted => {
                if (inserted.pos >= deleted.from && inserted.pos <= deleted.to) {
                    if(!conflicts.includes([inserted.data.step,"insertion",deleted.data.step,"deletion"]))
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
        const insertedsteps = []
        changes.changes.forEach(change=>{
            change.inserted.forEach(inserted=>insertedsteps.push({pos: invertedMapping.map(change.fromB), data: inserted.data}))
        })
        const deletedsteps = []
        changes.changes.forEach(change => {
            change.deleted.forEach(deleted=>deletedsteps.push({from: change.fromA, to: change.toA, data: deleted.data}))
        })
        return {insertedsteps, deletedsteps}
    }

    adjustDocument(data) {
        // Adjust the document when reconnecting after offline and many changes
        // happening on server.
        if (this.mod.editor.docInfo.version < data.doc.v) {
            const confirmedState = EditorState.create({doc: this.mod.editor.docInfo.confirmedDoc})
            const unconfirmedTr = confirmedState.tr
            sendableSteps(this.mod.editor.view.state).steps.forEach(step => unconfirmedTr.step(step))
            const rollbackTr = this.mod.editor.view.state.tr
            unconfirmedTr.steps.slice().reverse().forEach(
                (step, index) => rollbackTr.step(step.invert(unconfirmedTr.docs[unconfirmedTr.docs.length - index - 1]))
            )

            console.log("Unconfirmed steps",unconfirmedTr)
            
            // Reset to no local changes
            this.mod.editor.view.dispatch(receiveTransaction(
                this.mod.editor.view.state,
                unconfirmedTr.steps,
                unconfirmedTr.steps.map(_step => this.mod.editor.client_id)
            ))

            // Complete rollback properly
            this.mod.editor.view.dispatch(rollbackTr)

            // We reset to there being no local changes to send.
            this.mod.editor.view.dispatch(receiveTransaction(
                this.mod.editor.view.state,
                rollbackTr.steps,
                rollbackTr.steps.map(_step => this.mod.editor.client_id)
            ))
            

            const toDoc = this.mod.editor.schema.nodeFromJSON({type:'doc', content:[
                data.doc.contents
            ]})
            const lostTr = recreateTransform(this.mod.editor.docInfo.confirmedDoc, toDoc)
            let tracked
            const lostState = EditorState.create({doc: toDoc})
            const lostOnlineTr = receiveTransaction(
                this.mod.editor.view.state,
                lostTr.steps,
                lostTr.steps.map(_step => 'remote')
            )
            this.mod.editor.view.dispatch(lostOnlineTr)
            
            // Set Confirmed DOC
            this.mod.editor.docInfo.confirmedDoc = lostState.doc
            this.mod.editor.docInfo.confirmedJson = toMiniJSON(this.mod.editor.docInfo.confirmedDoc.firstChild)
            console.log("Lost online",lostTr)  
            
            // Try to condense the offline steps
            let start_step = unconfirmedTr.steps[0]
            // start_step.structure = true
            let mergedStep = start_step
            let condensedSteps = [] , x = mergedStep
            // condensedSteps.push(mergedStep)
            for(let i =1 ;i<unconfirmedTr.steps.length ; i++){
                // unconfirmedTr.steps[i].structure = true
                mergedStep = mergedStep.merge(unconfirmedTr.steps[i])
                // console.log("Wohooo",i,unconfirmedTr.steps[i],mergedStep)
                if(mergedStep === null){
                    condensedSteps.push(x)
                    mergedStep = unconfirmedTr.steps[i]
                    x = mergedStep
                } else {
                    x = mergedStep
                }
            }
            condensedSteps.push(mergedStep)
            
            const unconfirmedCondensedTr = confirmedState.tr
            condensedSteps.forEach(step=>unconfirmedCondensedTr.step(step))

            console.log("Condensed Steps",condensedSteps)
            console.log("Condensed Tr", unconfirmedCondensedTr)

            // Find the conflicting steps          
            let conflicts = this.findConflicts(unconfirmedCondensedTr,lostOnlineTr)
            console.log(conflicts)


            let rollbackOnlineConflictDeletionTr = this.mod.editor.view.state.tr
            let onlineConflictingDeltionIndex = [] , OnlineDeletionSteps = [] , offlineConflictingDeletionIndex = []  , offlineConflictingInsertionIndex= []

            // Store the indexes of conflicting deletion steps
            conflicts.forEach(conflict=>{
                if(!offlineConflictingDeletionIndex.includes(conflict[0]) && conflict[1] == "deletion"){
                    offlineConflictingDeletionIndex.push(conflict[0])
                }
                if(!onlineConflictingDeltionIndex.includes(conflict[2]) && conflict[3] == "deletion"){
                    onlineConflictingDeltionIndex.push(conflict[2])
                }
                if(!offlineConflictingInsertionIndex.includes(conflict[0]) && conflict[1] == "insertion"){
                    offlineConflictingInsertionIndex.push(conflict[0])
                }
            })

            // Rollback the online conflicting steps
            onlineConflictingDeltionIndex.sort(function(a, b){return a - b})
            onlineConflictingDeltionIndex.reverse()
            lostOnlineTr.steps.forEach((step,index)=>{
                onlineConflictingDeltionIndex.forEach(conflict=>{
                    if(index == conflict){
                        console.log("STEP",step,step.invert(lostOnlineTr.docs[index]))
                        if(!rollbackOnlineConflictDeletionTr.maybeStep(step.invert(lostOnlineTr.docs[index]).map(rollbackOnlineConflictDeletionTr.mapping)).failed){
                            OnlineDeletionSteps.push(step.map(rollbackOnlineConflictDeletionTr.mapping.slice(0,rollbackOnlineConflictDeletionTr.steps.length-1)))
                        } else {
                            const arr_index = onlineConflictingDeltionIndex.indexOf(index)
                            delete onlineConflictingDeltionIndex[arr_index]
                        }
                    }
                })
            })
            console.log(rollbackOnlineConflictDeletionTr)
            this.mod.editor.view.dispatch(rollbackOnlineConflictDeletionTr)
            
            const rebasedTr = this.mod.editor.view.state.tr
            let modifiedOnlineStepMaps = [] 
            let offset = 0

            // Modify the steps maps as we re-introduced the conflicting deletion.
            lostOnlineTr.mapping.maps.slice().map((map,index)=>{
                if(onlineConflictingDeltionIndex.includes(index)){
                    if(map.ranges.length>0 && map.ranges[1]>map.ranges[2]){
                        offset+=(map.ranges[1]-map.ranges[2])
                        map.ranges = []
                    }
                } else {
                    if(map.ranges.length>0)map.ranges[0]+=parseInt(offset)
                    modifiedOnlineStepMaps.push(map)
                }
            })

            // let maps = new Mapping([].concat(unconfirmedTr.mapping.maps.slice().reverse().map(map=>map.invert())).concat(lostOnlineTr.mapping.maps.slice().filter((map,index)=> !(z.includes(index) && (map.ranges.length>0 && map.ranges[1]>map.ranges[2])))))
            let maps = new Mapping([].concat(unconfirmedCondensedTr.mapping.maps.slice().reverse().map(map=>map.invert())).concat(modifiedOnlineStepMaps))
            // let maps2 = new Mapping([].concat(unconfirmedTr.mapping.maps.slice().reverse().map(map=>map.invert())).concat(lostOnlineTr.mapping.maps.slice()))
            // map((map,index)=>{
            //     if(z.includes(index)){
            //         if(map.ranges.length>0 && map.ranges[1]>map.ranges[2]){
            //             map.ranges = []
            //         }
            //     }
            //     return map
            // })))
            
            console.log(JSON.parse(JSON.stringify(maps)))
            let offlineconflictdeletion = [] , offlineConflictInsertion = []
            unconfirmedCondensedTr.steps.forEach(
                (step, index) => {
                    if(offlineConflictingDeletionIndex.includes(index)) {
                        console.log("MAPS:",maps.slice(unconfirmedCondensedTr.steps.length - index))
                        offlineconflictdeletion.push(step.map(maps.slice(unconfirmedCondensedTr.steps.length-index)))
                        console.log("assa",step.map(maps.slice(unconfirmedCondensedTr.steps.length - index)))
                        console.log("FROM",step.from,maps.slice(unconfirmedCondensedTr.steps.length - index).map(step.from))
                        console.log("TO",step.to,maps.slice(unconfirmedCondensedTr.steps.length - index).map(step.to))
                        // zzindex.push()
                    } else {
                        console.log("MAPS:",maps.slice(unconfirmedCondensedTr.steps.length - index))
                        const mapped = step.map(maps.slice(unconfirmedCondensedTr.steps.length - index))
                        if(offlineConflictingInsertionIndex.includes(index) && mapped) {
                            offlineConflictInsertion.push(mapped)
                        }
                        console.log(mapped)
                        if (mapped && !rebasedTr.maybeStep(mapped).failed) {
                            maps.appendMap(mapped.getMap())
                            maps.setMirror(unconfirmedCondensedTr.steps.length-index-1,(unconfirmedCondensedTr.steps.length+lostOnlineTr.steps.length-rollbackOnlineConflictDeletionTr.steps.length+rebasedTr.steps.length-1))
                        }
                    }

                }
            )

            console.log("ZZZ",offlineconflictdeletion)
            console.log("rebasedTr",rebasedTr)
            
            // Enable/Disable tracked changes based on some conditions
            let rebasedTrackedTr
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
                rebasedTrackedTr = rebasedTr
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


            this.mod.editor.docInfo.version = data.doc.v
            this.mod.editor.view.dispatch(rebasedTrackedTr)

            // Now accept all tracked insertions that are conflicting because when we have tracked delete on top the tracked insertions get deleted.
            console.log("OFfline insertions",offlineConflictInsertion)
            offlineConflictInsertion.forEach(step=>{
                if(step.from == step.to){
                    acceptAll(this.mod.editor.view,step.from,step.from+step.slice.size)
                }
                else {
                    acceptAll(this.mod.editor.view,step.from,step.to)
                }
            })


            let OnlineDeletionTr = this.mod.editor.view.state.tr
            OnlineDeletionSteps.forEach(step=>{
                const updatedMapping = rebasedTrackedTr.mapping
                updatedMapping.appendMapping(OnlineDeletionTr.mapping)
                OnlineDeletionTr.step(step.map(updatedMapping))
            })


            let onlineDeletionTrackedTr = trackedTransaction(
                OnlineDeletionTr,
                this.mod.editor.view.state,
                this.mod.editor.user,
                false,
                Date.now() - this.mod.editor.clientTimeAdjustment
            )
            onlineDeletionTrackedTr.setMeta('remote',true)
            this.mod.editor.view.dispatch(onlineDeletionTrackedTr)
            console.log("G:",OnlineDeletionTr)
            console.log("X:",onlineDeletionTrackedTr)
            
            // let gg = this.mod.editor.view.state.tr
            // zzz.reverse().forEach(step=>{
            //     console.log("ZZZ:",step[0].invert(rebasedTr.docs[step[1]]).map(rebasedTr.mapping))
            //     gg.step(step[0].invert(rebasedTr.docs[step[1]]))
            // })
            // this.mod.editor.view.dispatch(gg)

            let offlineDeletion = this.mod.editor.view.state.tr
            offlineconflictdeletion.forEach(step=>{
                offlineDeletion.step(step.map(offlineDeletion.mapping))
            })
            
            console.log("YY:",offlineDeletion)
            let offlineDeletionTr = trackedTransaction(
                offlineDeletion,
                this.mod.editor.view.state,
                this.mod.editor.user,
                false,
                Date.now() - this.mod.editor.clientTimeAdjustment
            )
            offlineDeletionTr.setMeta('remote',true)
            console.log("XX:",offlineDeletionTr)
            this.mod.editor.view.dispatch(offlineDeletionTr)
            

            // let yo = this.mod.editor.view.state.tr.setMeta('remote',true)
            // conflicts.forEach(conflict=>{
            //     if(conflict[3] == "insertion"){
            //         let xo = lostOnlineTr.steps[conflict[2]]
            //         yo.step(xo.map(rebasedTrackedTr.mapping))
            //     }
            // })
            // this.mod.editor.view.dispatch(yo)
            
            if (tracked) {
                showSystemMessage(
                    gettext(
                        'The document was modified substantially by other users while you were offline. We have merged your changes in as tracked changes. You should verify that your edits still make sense.'
                    )
                )
            }
            this.mod.editor.mod.footnotes.fnEditor.renderAllFootnotes()

        } else {
            // The server seems to have lost some data. We reset.
            this.loadDocument(data)
        }
    }

    loadDocument(data) {
        // Reset collaboration
        this.unconfirmedDiffs = {}
        if (this.awaitingDiffResponse) {
            this.enableDiffSending()
        }
        // Remember location hash to scroll there subsequently.
        const locationHash = window.location.hash

        this.mod.editor.clientTimeAdjustment = Date.now() - data.time

        this.mod.editor.docInfo = data.doc_info
        this.mod.editor.docInfo.version = data.doc.v
        this.mod.editor.docInfo.template = data.doc.template
        this.mod.editor.mod.db.bibDB.setDB(data.doc.bibliography)
        this.mod.editor.mod.db.imageDB.setDB(data.doc.images)
        this.mod.editor.docInfo.confirmedJson = JSON.parse(JSON.stringify(data.doc.contents))
        let stateDoc
        if (data.doc.contents.type) {
            stateDoc = this.mod.editor.schema.nodeFromJSON({type:'doc', content:[
                adjustDocToTemplate(
                    data.doc.contents,
                    this.mod.editor.docInfo.template.definition,
                    this.mod.editor.mod.documentTemplate.documentStyles,
                    this.mod.editor.schema
                )
            ]})
        } else {
            const definition = JSON.parse(JSON.stringify(this.mod.editor.docInfo.template.definition))
            if (!definition.type) {
                definition.type = 'article'
            }
            if (!definition.content) {
                definition.content = [{type: 'title'}]
            }
            stateDoc = this.mod.editor.schema.nodeFromJSON({type:'doc', content:[
                definition
            ]})
        }
        const plugins = this.mod.editor.statePlugins.map(plugin => {
            if (plugin[1]) {
                return plugin[0](plugin[1](data.doc))
            } else {
                return plugin[0]()
            }
        })

        const stateConfig = {
            schema: this.mod.editor.schema,
            doc: stateDoc,
            plugins
        }

        // Set document in prosemirror
        this.mod.editor.view.setProps({state: EditorState.create(stateConfig)})
        this.mod.editor.view.setProps({nodeViews: {}}) // Needed to initialize nodeViews in plugins
        // Set initial confirmed doc
        this.mod.editor.docInfo.confirmedDoc = this.mod.editor.view.state.doc

        // Render footnotes based on main doc
        this.mod.editor.mod.footnotes.fnEditor.renderAllFootnotes()

        //  Setup comment handling
        this.mod.editor.mod.comments.store.reset()
        this.mod.editor.mod.comments.store.loadComments(data.doc.comments)
        this.mod.editor.mod.marginboxes.view(this.mod.editor.view)
        // Set part specific settings
        this.mod.editor.mod.documentTemplate.addDocPartSettings()
        this.mod.editor.mod.documentTemplate.addCitationStylesMenuEntries()
        this.mod.editor.waitingForDocument = false
        deactivateWait()
        if (locationHash.length) {
            this.mod.editor.scrollIdIntoView(locationHash.slice(1))
        }
    }

    sendToCollaborators() {
        // Handle either doc change and comment updates OR caret update. Priority
        // for doc change/comment update.
        this.mod.editor.ws.send(() => {
            if (
                this.awaitingDiffResponse ||
                this.mod.editor.waitingForDocument ||
                this.receiving
            ) {
                return false
            } else if (
                sendableSteps(this.mod.editor.view.state) ||
                this.mod.editor.mod.comments.store.unsentEvents().length ||
                this.mod.editor.mod.db.bibDB.unsentEvents().length ||
                this.mod.editor.mod.db.imageDB.unsentEvents().length
            ) {
                console.log("Calling send to collabs")
                this.disableDiffSending()
                const stepsToSend = sendableSteps(this.mod.editor.view
                        .state),
                    fnStepsToSend = sendableSteps(this.mod.editor.mod
                        .footnotes.fnEditor.view.state),
                    commentUpdates = this.mod.editor.mod.comments.store
                    .unsentEvents(),
                    bibliographyUpdates = this.mod.editor.mod.db.bibDB
                    .unsentEvents(),
                    imageUpdates = this.mod.editor.mod.db.imageDB.unsentEvents()

                if (!stepsToSend &&
                    !fnStepsToSend &&
                    !commentUpdates.length &&
                    !bibliographyUpdates.length &&
                    !imageUpdates.length
                ) {
                    // no diff. abandon operation
                    return
                }
                const rid = this.confirmStepsRequestCounter++,
                    unconfirmedDiff = {
                        type: 'diff',
                        v: this.mod.editor.docInfo.version,
                        rid
                    }

                unconfirmedDiff['cid'] = this.mod.editor.client_id

                if (stepsToSend) {
                    unconfirmedDiff['ds'] = stepsToSend.steps.map(
                        s => s.toJSON()
                    )
                    // We add a json diff in a format understandable by the
                    // server.
                    console.log("Confirmed JSON",this.mod.editor.docInfo.confirmedJson)
                    console.log("The Other ONE!",toMiniJSON(
                        this.mod.editor.view.state.doc.firstChild
                    ))
                    unconfirmedDiff['jd'] = compare(
                        this.mod.editor.docInfo.confirmedJson,
                        toMiniJSON(
                            this.mod.editor.view.state.doc.firstChild
                        )
                    )
                    // In case the title changed, we also add a title field to
                    // update the title field instantly - important for the
                    // document overview page.
                    let newTitle = ""
                    this.mod.editor.view.state.doc.firstChild.firstChild.forEach(
                        child => {
                            if (!child.marks.find(mark => mark.type.name==='deletion')) {
                                newTitle += child.textContent
                            }
                        }
                    )
                    newTitle = newTitle.slice(0, 255)
                    let oldTitle = ""
                    this.mod.editor.docInfo.confirmedDoc.firstChild.firstChild.forEach(
                        child => {
                            if (!child.marks.find(mark => mark.type.name==='deletion')) {
                                oldTitle += child.textContent
                            }
                        }
                    )
                    oldTitle = oldTitle.slice(0, 255)
                    if (
                        newTitle !== oldTitle
                    ) {
                        unconfirmedDiff['ti'] = newTitle
                    }
                }

                if (fnStepsToSend) {
                    // We add the client ID to every single step
                    unconfirmedDiff['fs'] = fnStepsToSend.steps.map(
                        s => s.toJSON()
                    )
                }
                if (commentUpdates.length) {
                    unconfirmedDiff["cu"] = commentUpdates
                }
                if (bibliographyUpdates.length) {
                    unconfirmedDiff["bu"] = bibliographyUpdates
                }
                if (imageUpdates.length) {
                    unconfirmedDiff["iu"] = imageUpdates
                }

                this.unconfirmedDiffs[rid] = Object.assign(
                    {doc: this.mod.editor.view.state.doc},
                    unconfirmedDiff
                )
                return unconfirmedDiff

            } else if (getSelectionUpdate(this.mod.editor.currentView.state)) {
                const currentView = this.mod.editor.currentView

                if (this.lastSelectionUpdateState === currentView.state) {
                    // Selection update has been sent for this state already. Skip
                    return false
                }
                this.lastSelectionUpdateState = currentView.state
                // Create a new caret as the current user
                const selectionUpdate = getSelectionUpdate(currentView.state)
                return {
                    type: 'selection_change',
                    id: this.mod.editor.user.id,
                    v: this.mod.editor.docInfo.version,
                    session_id: this.mod.editor.docInfo.session_id,
                    anchor: selectionUpdate.anchor,
                    head: selectionUpdate.head,
                    // Whether the selection is in the footnote or the main editor
                    editor: currentView === this.mod.editor.view ?
                        'main' : 'footnotes'
                }
            } else {
                return false
            }
        })

    }

    receiveSelectionChange(data) {
        const participant = this.mod.participants.find(par => par.id === data
                .id)
        let tr, fnTr
        if (!participant) {
            // participant is still unknown to us. Ignore
            return
        }
        if (data.editor === 'footnotes') {
            fnTr = updateCollaboratorSelection(
                this.mod.editor.mod.footnotes.fnEditor.view.state,
                participant,
                data
            )
            tr = removeCollaboratorSelection(
                this.mod.editor.view.state,
                data
            )
        } else {
            tr = updateCollaboratorSelection(
                this.mod.editor.view.state,
                participant,
                data
            )
            fnTr = removeCollaboratorSelection(
                this.mod.editor.mod.footnotes.fnEditor.view.state,
                data
            )
        }
        if (tr) {
            this.mod.editor.view.dispatch(tr)
        }
        if (fnTr) {
            this.mod.editor.mod.footnotes.fnEditor.view.dispatch(fnTr)
        }
    }

    receiveFromCollaborators(data) {
        console.log("Server",data)

        this.mod.editor.docInfo.version++
        if (data["bu"]) { // bibliography updates
            this.mod.editor.mod.db.bibDB.receive(data["bu"])
        }
        if (data["iu"]) { // images updates
            this.mod.editor.mod.db.imageDB.receive(data["iu"])
        }
        if (data["cu"]) { // comment updates
            this.mod.editor.mod.comments.store.receive(data["cu"])
        }
        if (data["ds"]) { // document steps
            this.applyDiffs(data["ds"], data["cid"])
        }
        if (data["fs"]) { // footnote steps
            this.mod.editor.mod.footnotes.fnEditor.applyDiffs(data["fs"], data["cid"])
        }

        if (data.server_fix) {
            // Diff is a fix created by server due to missing diffs.
            if ('reject_request_id' in data) {
                delete this.unconfirmedDiffs[data.reject_request_id]
            }
            this.cancelCurrentlyCheckingVersion()

            // There may be unsent local changes. Send them now after .5 seconds,
            // in case collaborators want to send something first.
            this.enableDiffSending()
            window.setTimeout(() => this.sendToCollaborators(), 500)

        }
    }

    setConfirmedDoc(tr, stepsLength) {
        // Find the latest version of the doc without any unconfirmed local changes

        const rebased = tr.getMeta("rebased"),
            docNumber = rebased + stepsLength

        this.mod.editor.docInfo.confirmedDoc = docNumber === tr.docs.length ?
            tr.doc :
            tr.docs[docNumber]
        this.mod.editor.docInfo.confirmedJson = toMiniJSON(this.mod.editor.docInfo.confirmedDoc.firstChild)
    }

    confirmDiff(request_id) {
        const unconfirmedDiffs = this.unconfirmedDiffs[request_id]
        if (!unconfirmedDiffs) {
            return
        }
        this.mod.editor.docInfo.version++

        const sentSteps = unconfirmedDiffs["ds"] // document steps
        if (sentSteps) {
            const ourIds = sentSteps.map(
                _step => this.mod.editor.client_id
            )
            const tr = receiveTransaction(
                this.mod.editor.view.state,
                sentSteps,
                ourIds
            )
            this.mod.editor.view.dispatch(tr)
            this.mod.editor.docInfo.confirmedDoc = unconfirmedDiffs["doc"]
            this.mod.editor.docInfo.confirmedJson = toMiniJSON(
                this.mod.editor.docInfo.confirmedDoc.firstChild
            )
        }

        const sentFnSteps = unconfirmedDiffs["fs"] // footnote steps
        if (sentFnSteps) {
            const fnTr = receiveTransaction(
                this.mod.editor.mod.footnotes.fnEditor.view.state,
                sentFnSteps,
                sentFnSteps.map(
                    _step => this.mod.editor.client_id
                )
            )
            this.mod.editor.mod.footnotes.fnEditor.view.dispatch(fnTr)
        }

        const sentComments = unconfirmedDiffs["cu"] // comment updates
        if (sentComments) {
            this.mod.editor.mod.comments.store.eventsSent(sentComments)
        }

        const sentBibliographyUpdates = unconfirmedDiffs["bu"] // bibliography updates
        if (sentBibliographyUpdates) {
            this.mod.editor.mod.db.bibDB.eventsSent(sentBibliographyUpdates)
        }

        const sentImageUpdates = unconfirmedDiffs["iu"] // image updates
        if (sentImageUpdates) {
            this.mod.editor.mod.db.imageDB.eventsSent(sentImageUpdates)
        }

        delete this.unconfirmedDiffs[request_id]
        this.enableDiffSending()
    }

    rejectDiff(request_id) {
        delete this.unconfirmedDiffs[request_id]
        this.enableDiffSending()
    }

    applyDiffs(diffs, cid) {
        this.receiving = true
        const steps = diffs.map(j => Step.fromJSON(this.mod.editor.schema, j))
        const clientIds = diffs.map(_ => cid)
        const tr = receiveTransaction(
            this.mod.editor.view.state,
            steps,
            clientIds
        )
        tr.setMeta('remote', true)
        this.mod.editor.view.dispatch(tr)
        this.setConfirmedDoc(tr, steps.length)
        this.receiving = false
        this.sendToCollaborators()
    }
}
