import {Plugin, PluginKey , TextSelection, NodeSelection} from "prosemirror-state"
import {Decoration, DecorationSet , __serializeForClipboard} from "prosemirror-view"
import {noSpaceTmp, showSystemMessage} from "../../common"
import { Mapping } from "prosemirror-transform"

const key = new PluginKey('mergeDiff')

export const updateMarkData = function(tr){
    // Update the range inside the marks !!
    const initialdiffMap = tr.getMeta('initialDiffMap')
    if(!initialdiffMap && (tr.steps.length>0 || tr.docChanged)){
        tr.doc.nodesBetween(
            0,
            tr.doc.content.size,
            (node, pos) => {
                if (['bullet_list', 'ordered_list'].includes(node.type.name)) {
                    return true
                } else if (node.isInline){
                    let diffMark = node.marks.find(mark=>mark.type.name=="DiffMark")
                    if(diffMark!== undefined){
                        diffMark = diffMark.attrs
                        tr.removeMark(pos,pos+node.nodeSize,tr.doc.type.schema.marks.DiffMark)
                        const from = tr.mapping.map(diffMark.from)
                        const to = tr.mapping.map(diffMark.to,-1)
                        const mark = tr.doc.type.schema.marks.DiffMark.create({ diff:diffMark.diff,steps:diffMark.steps,from:from,to:to })
                        tr.addMark(pos,pos+node.nodeSize,mark)
                    }
                }
                if (node.attrs.diffdata && node.attrs.diffdata.length>0) {
                    const diffdata = node.attrs.diffdata
                    diffdata[0].from = tr.mapping.map(diffdata[0].from)
                    diffdata[0].to = tr.mapping.map(diffdata[0].to)
                    tr.setNodeMarkup(pos, null, Object.assign({}, node.attrs, {diffdata}), node.marks)
                }
            }
        )
    }
    return tr
}

export const removeMarks = function(view,from,to,mark,returnTr=false){
    const trackedTr = view.state.tr
    trackedTr.doc.nodesBetween(
        from,
        to,
        (node, pos) => {
            if (pos < from || ['bullet_list', 'ordered_list'].includes(node.type.name)) {
                return true
            } else if (node.isInline) {
                return false
            }
            if (node.attrs.diffdata && node.attrs.diffdata.length>0) {
                const diffdata = []
                trackedTr.setNodeMarkup(pos, null, Object.assign({}, node.attrs, {diffdata}), node.marks)
            }
        }
    )
    trackedTr.removeMark(from,to,mark)
    if(returnTr){
        return trackedTr
    }
    trackedTr.setMeta('initialDiffMap',true).setMeta('mapTracked',true)
    trackedTr.setMeta('notrack',true)
    view.dispatch(trackedTr)
}

export const diffPlugin = function(options) {

    function getDiffMark(state) {
        let markFound = state.selection.$head.marks().find(mark =>
            mark.type.name === 'DiffMark')

        if(markFound === undefined){
            markFound = {}
            const node = state.selection.$head.nodeBefore
            if(node  && node.attrs.diffdata && node.attrs.diffdata.length>0){
                markFound['diff'] = node.attrs.diffdata[0].type
                markFound['attrs'] = {}
                markFound['attrs']['diff'] = node.attrs.diffdata[0].type
                markFound['attrs']['from'] = node.attrs.diffdata[0].from
                markFound['attrs']['to'] = node.attrs.diffdata[0].to
                markFound['attrs']['steps'] = node.attrs.diffdata[0].steps
            }
        }
        return markFound
    }

    function createHiglightDecoration(from,to,state){
        const inlineDeco = Decoration.inline(from,to,{class:'selected-dec'})
        const deco = []
        deco.push(inlineDeco)
        state.doc.nodesBetween(
            from,
            to,
            (node, pos) => {
                if (pos < from || ['bullet_list', 'ordered_list'].includes(node.type.name)) {
                    return true
                } else if (node.isInline) {
                    return false
                }
                if (node && node.attrs.diffdata && node.attrs.diffdata.length>0) {
                    deco.push(Decoration.node(pos,pos+node.nodeSize,{class:'selected-dec'},{}))
                }
            }
        )
        return deco
    }

    function getDecos(state) {
        const $head = state.selection.$head
        const currentMarks = [],
            diffMark = $head.marks().find(
                mark => mark.type.name === 'DiffMark'
            )
        const linkMark = $head.marks().find(
            mark => mark.type.name === 'link'
        ) 
        if (diffMark) {
            currentMarks.push(diffMark)
        }
        if (!currentMarks.length) {
            const node = state.selection instanceof NodeSelection ? state.selection.node : state.selection.$head.parent
            let markFound = {}
            if(node && node.attrs.diffdata && node.attrs.diffdata.length>0){
                markFound['image'] = true
                markFound['attrs'] = {}
                markFound['attrs']['diff'] = node.attrs.diffdata[0].type
                markFound['attrs']['from'] = node.attrs.diffdata[0].from
                markFound['attrs']['to'] = node.attrs.diffdata[0].to
                markFound['attrs']['steps'] = JSON.stringify(node.attrs.diffdata[0].steps)
                let startPos = $head.pos// position of block start.
                const dom = createDropUp(markFound),
                deco = Decoration.widget(startPos,dom)
                let highlightDecos = createHiglightDecoration(markFound['attrs']["from"],markFound['attrs']["to"],state)
                highlightDecos.push(deco)
                return DecorationSet.create(state.doc,highlightDecos)
            }
            return DecorationSet.empty
        }
        const startPos = diffMark.attrs.to
        const dom = createDropUp(diffMark,linkMark),
            deco = Decoration.widget(startPos,dom)
        let highlightDecos = createHiglightDecoration(diffMark.attrs.from,diffMark.attrs.to,state)
        highlightDecos.push(deco)
        return DecorationSet.create(state.doc,highlightDecos)
    }

    function acceptChanges(mark,editor,mergeView,originalView,tr,trType){
        try {
            const mergedDocMap = editor.mod.collab.doc.merge.mergedDocMap
            let insertionTr = mergeView.state.tr
            const from = mark.attrs.from
            const to = mark.attrs.to
            const steps = JSON.parse(mark.attrs.steps)
            let stepMaps = tr.mapping.maps.slice().reverse().map(map=>map.invert())
            let rebasedMapping = new Mapping(stepMaps)
            rebasedMapping.appendMapping(mergedDocMap)
            for(let stepIndex of steps){
                const maps = rebasedMapping.slice(tr.steps.length-stepIndex)
                const mappedStep = tr.steps[stepIndex].map(maps)
                if(mappedStep && !insertionTr.maybeStep(mappedStep).failed){
                    mergedDocMap.appendMap(mappedStep.getMap())
                    rebasedMapping.appendMap(mappedStep.getMap())
                    rebasedMapping.setMirror(tr.steps.length-stepIndex-1,(tr.steps.length+mergedDocMap.maps.length-1))
                }
            }
            // Make sure that all the content steps are present in the new transaction
            if(insertionTr.steps.length < steps.length){
                showSystemMessage(gettext("The change could not be applied automatically.Please consider using the copy option to copy the changes."))
            } else {
                // Remove the diff mark.If we're looking at view2 it means we're deleting content for which we dont have to remove the marks seperately we can put both of the steps into a single transaction
                if(originalView === mergeView){
                    let markRemovalTr = removeMarks(originalView,from,to,editor.schema.marks.DiffMark,true)
                    insertionTr.steps.forEach(step => markRemovalTr.step(step))
                    insertionTr = markRemovalTr
                } else {
                    removeMarks(originalView,from,to,editor.schema.marks.DiffMark)
                }
                insertionTr.setMeta('mapTracked',true)
                insertionTr.setMeta('notrack',true)
                mergeView.dispatch(insertionTr)
            }
        } catch(exc){
            showSystemMessage(gettext("The change could not be applied automatically.Please consider using the copy option to copy the changes."))
        }
    }

    function rejectChanges(view,diffMark,editor){
        removeMarks(view,diffMark.attrs.from,diffMark.attrs.to,editor.schema.marks.DiffMark)
    }

    function copyChange(view,from,to){
        const tr = view.state.tr
        const resolvedFrom = view.state.doc.resolve(from)
        const resolvedTo = view.state.doc.resolve(to)
        const sel = new TextSelection(resolvedFrom,resolvedTo)
        sel.visible = false
        tr.setSelection(sel)
        view.dispatch(tr)
        
        const slice = view.state.selection.content()
        const {dom,text} = (__serializeForClipboard(view,slice))

        // Copy data to clipboard!!
        document.body.appendChild(dom)
        var range = document.createRange();
        range.selectNode(dom);
        window.getSelection().addRange(range);
        try {
            document.execCommand("copy") // Security exception may be thrown by some browsers.
            document.body.removeChild(dom)
            showSystemMessage(gettext('Change copied to clipboard'))
        } catch (ex) {
            showSystemMessage(gettext(
                'Copy to clipboard failed. Please copy manually.'
            ))
        }
        window.getSelection().removeAllRanges();
    }

    function createDropUp(diffMark,linkMark) {
        const dropUp = document.createElement('span'),
        editor = options.editor,requiredPx=10,
        tr = diffMark.attrs.diff.search('offline') != -1 ? editor.mod.collab.doc.merge.offlineTr : editor.mod.collab.doc.merge.onlineTr
        const trType = diffMark.attrs.diff.search('offline') != -1 ? "offline" : "online"
        let view
        if(diffMark.attrs.diff.search('offline') != -1){
            if(diffMark.attrs.diff.search('inserted') != -1){
                view = editor.mod.collab.doc.merge.mergeView1
            } else {
                view = editor.mod.collab.doc.merge.mergeView2
            }
        } else {
            if(diffMark.attrs.diff.search('inserted') != -1){
                view = editor.mod.collab.doc.merge.mergeView3
            } else {
                view = editor.mod.collab.doc.merge.mergeView2
            }
        }
        linkMark = linkMark === undefined ? false : linkMark
        dropUp.classList.add('drop-up-outer')
        dropUp.innerHTML = noSpaceTmp`
            <div class="link drop-up-inner" style="top: -${requiredPx}px;">
                ${
                    diffMark ?
                    `<div class="drop-up-head">
                        ${
                            diffMark.attrs.diff ?
                            `<div class="link-title">${gettext('Change')}:&nbsp; ${ (diffMark.attrs.diff.search('deleted') !=-1) ? (diffMark.attrs.diff.search('offline') !=-1 ? gettext('Deleted by you') :gettext('Deleted by Online user')):''}</div>` :
                            ''
                        }
                        ${
                            linkMark ? `<div> Link : ${linkMark.attrs.href}</div>`:``
                        }
                        ${
                            linkMark ? `<div> Type : ${linkMark.attrs.href[0] == "#"?`internal`:`external`}</div>`:``
                        }
                    </div>
                    <ul class="drop-up-options">
                        <li class="accept-change" title="${gettext('Accept Change')}">
                            ${gettext('Accept Change')}
                        </li>
                        <li class="reject-change" title="${gettext('Reject Change')}">
                            ${gettext('Reject Change')}
                        </li>
                        <li class="copy-data" title="${gettext('Copy')}">
                            ${gettext('Copy')}
                        </li>
                    </ul>` :
                    ''
                }
            </div>`

        const acceptChange = dropUp.querySelector('.accept-change')
        if (acceptChange) {
            acceptChange.addEventListener('mousedown',
                event => {
                    event.preventDefault()
                    event.stopImmediatePropagation()
                    acceptChanges(diffMark,editor,editor.mod.collab.doc.merge.mergeView2,view,tr,trType)
                }
            )
        }
        const rejectChange = dropUp.querySelector('.reject-change')
        if (rejectChange) {
            rejectChange.addEventListener('mousedown',
                () => {
                    event.preventDefault()
                    event.stopImmediatePropagation()
                    rejectChanges(view,diffMark,editor)
                }
            )
        }

        const copyData = dropUp.querySelector('.copy-data')
        if (copyData) {
            copyData.addEventListener('mousedown',
                event => {
                    event.preventDefault()
                    event.stopImmediatePropagation()
                    copyChange(view,diffMark.attrs.from,diffMark.attrs.to)
                }
            )
        }
        return dropUp
    }

    return new Plugin({
        key,
        state: {
            init() {
                return {
                    decos: DecorationSet.empty,
                    diffMark: false
                }
            },
            apply(tr, prev, oldState, state) {
                let {
                    decos,
                    diffMark,
                } = this.getState(oldState)
                const newDiffMark = getDiffMark(state)
                if (newDiffMark === diffMark) {
                    decos = decos.map(tr.mapping, tr.doc)
                } else {
                    decos = getDecos(state)
                    diffMark = newDiffMark
                }
                return {
                    decos,
                    diffMark,
                }
            }
        },
        props: {
            decorations(state) {
                const {
                    decos
                } = this.getState(state)
                return decos
            }
        },
        view(_view){
            return {
                update:(view)=>{
                    // Make sure that pop stays inside the view.
                    const changePopUp = view.dom.querySelector('.drop-up-outer')
                    if(changePopUp){
                        const bounding = changePopUp.getBoundingClientRect()
                        if(bounding.right > (window.innerWidth || document.documentElement.clientWidth)){
                            changePopUp.style.left = '100px'
                        }
                    }
                }  
            }
        }
    })
}
