import deepEqual from "fast-deep-equal"
import {edtfParse} from "biblatex-csl-converter"
import {Dialog, findTarget} from "../common"
import {copyrightTemplate, licenseInputTemplate, licenseSelectTemplate} from "./templates"

export class CopyrightDialog {
    constructor(copyright) {
        this.copyright = copyright
        this.origCopyright = copyright
        this.dialog = false
    }

    getCurrentValue() {
        this.copyright = {}
        const holder = this.dialog.dialogEl.querySelector('.holder').value
        this.copyright.holder = holder.length ? holder : false
        const year = this.dialog.dialogEl.querySelector('.year').value
        this.copyright.year = year.length ? Math.max(0, Math.min(parseInt(year) || 0, 2100)) : false
        this.copyright.freeToRead = this.dialog.dialogEl.querySelector('.free-to-read:checked') ? true : false
        const licenseStartDates = Array.from(this.dialog.dialogEl.querySelectorAll('.license-start')).map(el => el.value)
        this.copyright.licenses = Array.from(this.dialog.dialogEl.querySelectorAll('.license')).map((el, index) => {
            if (!el.value.length) {
                return false
            } else {
                const returnValue = {url: el.value}
                const startDate = edtfParse(licenseStartDates[index])
                if (startDate.valid && startDate.type==='Date' && !startDate.uncertain && !startDate.approximate && startDate.values.length === 3) {
                    returnValue.start = startDate.cleanedString
                }
                return returnValue
            }
        }).filter(license => license)
    }

    init() {
        return new Promise(resolve => {
            const buttons = []
            buttons.push({
                text: gettext('Change'),
                classes: 'fw-dark',
                click: () => {
                    this.dialog.close()
                    this.getCurrentValue()
                    if (deepEqual(this.copyright, this.origCopyright)) {
                        // No change.
                        resolve(false)
                    }
                    resolve(this.copyright)
                }
            })

            buttons.push({
                type: 'cancel'
            })

            this.dialog = new Dialog({
                width: 940,
                height: 300,
                id: 'configure-copyright',
                title: gettext('Set copyright information'),
                body: copyrightTemplate(this.copyright),
                buttons
            })

            this.dialog.open()
            this.bind()
        })
    }

    bind() {
        this.dialog.dialogEl.addEventListener('click', event => {
            const el = {}
            switch (true) {
                case findTarget(event, '.type-switch', el): {
                    const url = el.target.nextElementSibling.querySelector('.license').value
                    if (el.target.classList.contains('value1')) {
                        el.target.classList.add('value2')
                        el.target.classList.remove('value1')
                        el.target.nextElementSibling.innerHTML = licenseInputTemplate({url})
                    } else {
                        el.target.classList.add('value1')
                        el.target.classList.remove('value2')
                        el.target.nextElementSibling.innerHTML = licenseSelectTemplate({url})
                    }
                    break
                }
                case findTarget(event, '.fa-plus-circle', el): {
                    this.getCurrentValue()
                    this.dialog.dialogEl.querySelector('#configure-copyright').innerHTML = copyrightTemplate(this.copyright)
                    break
                }
                case findTarget(event, '.fa-minus-circle', el): {
                    const tr = el.target.closest('tr')
                    tr.parentElement.removeChild(tr)
                    this.getCurrentValue()

                    this.dialog.dialogEl.querySelector('#configure-copyright').innerHTML = copyrightTemplate(this.copyright)
                    break
                }
                default:
                    break
            }
        })
    }
}