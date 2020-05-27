import {Plugin, PluginKey , TextSelection, NodeSelection} from "prosemirror-state"
import {Decoration, DecorationSet , __serializeForClipboard} from "prosemirror-view"
import {noSpaceTmp, addAlert} from "../../common"
import { Mapping } from "prosemirror-transform"

const key = new PluginKey('mergeDiff')

export const removeMarks = function(view,from,to,mark){
    const trackedTr = view.state.tr
        trackedTr.doc.nodesBetween(
            from,
            to,
            (node, pos) => {
                if (pos < from || ['bullet_list', 'ordered_list'].includes(node.type.name)) {
                    return true
                } else if (node.isInline || ['table_row', 'table_cell'].includes(node.type.name)) {
                    return false
                }
                if (node.attrs.diffdata && node.attrs.diffdata.length>0) {
                    const diffdata = []
                    trackedTr.setNodeMarkup(pos, null, Object.assign({}, node.attrs, {diffdata}), node.marks)
                }
                if (node.type.name==='table') {
                    // A table was inserted. We don't add track marks to elements inside of it.
                    return false
                }
            }
        )
        trackedTr.removeMark(from,to,mark)
        trackedTr.setMeta('initialDiffMap',true)
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
                } else if (node.isInline || ['table_row', 'table_cell'].includes(node.type.name)) {
                    return false
                }
                if (node && node.attrs.diffdata && node.attrs.diffdata.length>0) {
                    deco.push(Decoration.node(pos,pos+node.nodeSize,{class:'selected-dec'},{}))
                }
                if (node.type.name==='table') {
                    // A table was inserted. We don't add track marks to elements inside of it.
                    return false
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
        const dom = createDropUp(diffMark),
            deco = Decoration.widget(startPos,dom)
        let highlightDecos = createHiglightDecoration(diffMark.attrs.from,diffMark.attrs.to,state)
        highlightDecos.push(deco)
        return DecorationSet.create(state.doc,highlightDecos)
    }

    function acceptChanges(mark,editor,mergeView,originalView,tr){
        try {
            const mergedDocMap = editor.mod.collab.doc.merge.mergedDocMap
            const insertionTr = mergeView.state.tr
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
                addAlert('warning',gettext("The change could not be applied automatically.Please consider using the copy option to copy the changes."))
            } else {
                insertionTr.setMeta('mapTracked',true)
                if(!tr.doc.firstChild.attrs.tracked)
                    insertionTr.setMeta('notrack',true)
                mergeView.dispatch(insertionTr)
                // Remove the diff mark
                removeMarks(originalView,from,to,editor.schema.marks.DiffMark)
            }
        } catch(exc){
            addAlert('warning',gettext("The change could not be applied automatically.Please consider using the copy option to copy the changes."))
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
        console.log(dom)
        var range = document.createRange();
        range.selectNode(dom);
        window.getSelection().addRange(range);
        try {
            document.execCommand("copy") // Security exception may be thrown by some browsers.
            document.body.removeChild(dom)
            addAlert('info', gettext('Change copied to clipboard'))
        } catch (ex) {
            addAlert('info', gettext(
                'Copy to clipboard failed. Please copy manually.'
            ))
        }
        window.getSelection().removeAllRanges();
    }

    function createDropUp(diffMark) {
        const dropUp = document.createElement('span'),
        editor = options.editor,requiredPx=10,
        tr = diffMark.attrs.diff.search('offline') != -1 ? editor.mod.collab.doc.merge.offlineTr : editor.mod.collab.doc.merge.onlineTr
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
                    console.log(diffMark)
                    acceptChanges(diffMark,editor,editor.mod.collab.doc.merge.mergeView2,view,tr)
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
        }
    })
}
