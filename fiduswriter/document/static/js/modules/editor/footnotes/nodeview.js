import {
    EditorState
} from "prosemirror-state"
import {
    EditorView
} from "prosemirror-view"
import {fnSchema} from "../../schema/footnotes"

export class FootnoteView {
    constructor(node, view, getPos) {
        console.log("FootenoteVIEW insatan")
        // We'll need these later
        this.node = node
        this.outerView = view
        this.getPos = getPos

        // The node's representation in the editor (empty, for now)
        this.dom = document.createElement("footnote")
        // These are used when the footnote is selected
        this.innerView = null
        // Updated main editor state
        this.updatedMainEditor = false

    }


    selectNode() {
        this.dom.classList.add("ProseMirror-selectednode")
        if (!this.innerView) this.open()
    }

    deselectNode() {
        console.log("Dekselecnode")
        this.dom.classList.remove("ProseMirror-selectednode")
        if (this.innerView) this.close()
    }

    open() {
        // Append a tooltip to the outer node
        let tooltip = this.dom.appendChild(document.createElement("div"))
        tooltip.className = "footnote-tooltip"

        const doc = fnSchema.nodeFromJSON({
            type: "doc",
            content:[{
                type:"footnotecontainer",
                content:this.node.attrs.footnote
            }]
        })

        // And put a sub-ProseMirror into that
        this.innerView = new EditorView(tooltip, {
            state: EditorState.create({
                doc: doc,
            }),
            dispatchTransaction: this.dispatchInner.bind(this),
            handleDOMEvents: {
                mousedown: () => {
                    if (this.outerView.hasFocus()) this.innerView.focus()
                }
            }
        })
    }

    close() {
        if(!this.updatedMainEditor){
            this.updateMainEditor()
        }
        if(this.innerView){
            this.innerView.destroy()
            this.innerView = null
            this.dom.textContent = ""
            this.updatedMainEditor = false
        }
    }

    updateMainEditor(){
        let outerTr = this.outerView.state.tr
        const footnoteContent = this.innerView.state.doc.child(0).toJSON().content
        const pos = this.getPos()
        const node = outerTr.doc.nodeAt(pos)
        if(node){
            outerTr.setNodeMarkup(pos, node.type, {
                footnote: footnoteContent
            })
        }
        if (outerTr.docChanged) {
            outerTr.setMeta('fromFootnote',true)
            this.updatedMainEditor = true
            this.outerView.dispatch(outerTr)
        }
    }

    dispatchInner(tr) {
        let {
            state,
            transactions
        } = this.innerView.state.applyTransaction(tr)
        this.innerView.updateState(state)
    }

    update(node) {
        this.node = node
        return true
    }

    destroy() {
        if (this.innerView) this.close()
    }

    stopEvent(event) {
        return this.innerView && this.innerView.dom.contains(event.target)
    }

    ignoreMutation() {
        return true
    }
}