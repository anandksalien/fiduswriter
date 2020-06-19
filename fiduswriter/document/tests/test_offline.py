import multiprocessing
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from testing.testcases import LiveTornadoTestCase
from .editor_helper import EditorHelper
from document.ws_views import WebSocket
from django.conf import settings
import os
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.keys import Keys


class OfflineTests(LiveTornadoTestCase, EditorHelper):
    """
    Tests in which two browsers collaborate and the connection is interrupted.
    """
    user = None
    TEST_TEXT = "Lorem ipsum dolor sit amet."
    MULTILINE_TEST_TEXT = "Lorem ipsum\ndolor sit amet."
    fixtures = [
        'initial_documenttemplates.json',
        'initial_styles.json',
    ]

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        driver_data = cls.get_drivers(2)
        cls.driver = driver_data["drivers"][0]
        cls.driver2 = driver_data["drivers"][1]
        cls.client = driver_data["clients"][0]
        cls.client2 = driver_data["clients"][1]
        cls.wait_time = driver_data["wait_time"]

    @classmethod
    def tearDownClass(cls):
        cls.driver.quit()
        cls.driver2.quit()
        super().tearDownClass()

    def setUp(self):
        self.user = self.create_user()
        self.login_user(self.user, self.driver, self.client)
        self.login_user(self.user, self.driver2, self.client2)
        self.doc = self.create_new_document()

    def tearDown(self):
        self.leave_site(self.driver)
        self.leave_site(self.driver2)

    def test_simple(self):
        """
        Test one client going offline in collaborative mode while both clients
        continue to write and whether documents are synched when user returns
        online.
        """
        self.load_document_editor(self.driver, self.doc)
        self.load_document_editor(self.driver2, self.doc)

        self.add_title(self.driver)
        self.driver.find_element_by_class_name(
            'article-body'
        ).click()

        p1 = multiprocessing.Process(
            target=self.type_text,
            args=(self.driver, self.TEST_TEXT)
        )
        p1.start()

        # Wait for the first processor to write some text
        self.wait_for_doc_size(self.driver2, 34)

        # driver 2 goes offline
        self.driver2.execute_script(
            'window.theApp.page.ws.goOffline()'
        )

        self.driver2.find_element_by_class_name(
            'article-body'
        ).click()

        # Total: 25
        self.driver2.execute_script(
            'window.testCaret.setSelection(25,25)'
        )

        p2 = multiprocessing.Process(
            target=self.type_text,
            args=(self.driver2, self.TEST_TEXT)
        )
        p2.start()
        p1.join()
        p2.join()

        # driver 2 goes online
        self.driver2.execute_script(
            'window.theApp.page.ws.goOnline()'
        )

        self.wait_for_doc_sync(self.driver, self.driver2)

        self.assertEqual(
            len(self.TEST_TEXT) * 2,
            len(self.get_contents(self.driver))
        )

        self.assertEqual(
            self.get_contents(self.driver2),
            self.get_contents(self.driver)
        )

    def test_too_many_diffs(self):
        """
        Test one client going offline in collaborative mode while both clients
        continue to write with the cionnected clients adding too many items to
        the history so that the server no longer can provide it with all
        missing steps. The client therefore needs to recretae the missing steps
        by itself.
        """

        # The history length stored by the server is shortened from 1000 to 1.
        WebSocket.history_length = 1

        self.load_document_editor(self.driver, self.doc)
        self.load_document_editor(self.driver2, self.doc)

        self.add_title(self.driver)
        self.driver.find_element_by_class_name(
            'article-body'
        ).click()

        p1 = multiprocessing.Process(
            target=self.type_text,
            args=(self.driver, self.TEST_TEXT)
        )
        p1.start()

        # Wait for the first processor to write some text
        self.wait_for_doc_size(self.driver2, 34)

        # driver 2 goes offline
        self.driver2.execute_script(
            'window.theApp.page.ws.goOffline()'
        )

        self.driver2.find_element_by_class_name(
            'article-body'
        ).click()

        # Total: 25
        self.driver2.execute_script(
            'window.testCaret.setSelection(25,25)'
        )

        p2 = multiprocessing.Process(
            target=self.type_text,
            args=(self.driver2, self.TEST_TEXT)
        )
        p2.start()
        p1.join()
        p2.join()

        # driver 2 goes online
        self.driver2.execute_script(
            'window.theApp.page.ws.goOnline()'
        )

        self.wait_for_doc_sync(self.driver, self.driver2)

        self.assertEqual(
            len(self.TEST_TEXT) * 2,
            len(self.get_contents(self.driver))
        )

        self.assertEqual(
            self.get_contents(self.driver2),
            self.get_contents(self.driver)
        )

        WebSocket.history_length = 1000

    def test_too_many_diffs_with_tracking(self):
        """
        Test one client going offline in collaborative mode while both clients
        continue to write with the cionnected clients adding too many items to
        the history so that the server no longer can provide it with all
        missing steps. The client therefore needs to recreate the missing steps
        by itself. The limit of steps is set so that tracking kicks in.
        """

        # The history length stored by the server is shortened from 1000 to 1.
        WebSocket.history_length = 1

        self.load_document_editor(self.driver, self.doc)
        self.load_document_editor(self.driver2, self.doc)

        self.add_title(self.driver)
        self.driver.find_element_by_class_name(
            'article-body'
        ).click()

        p1 = multiprocessing.Process(
            target=self.type_text,
            args=(self.driver, self.TEST_TEXT)
        )
        p1.start()

        # Wait for the first processor to write some text
        self.wait_for_doc_size(self.driver2, 34)

        # driver 2 sets tracking limit
        self.driver2.execute_script(
            'window.theApp.page.mod.collab.doc.merge.trackOfflineLimit = 0'
        )

        # driver 2 goes offline
        self.driver2.execute_script(
            'window.theApp.page.ws.goOffline()'
        )

        self.driver2.find_element_by_class_name(
            'article-body'
        ).click()

        # Total: 25
        self.driver2.execute_script(
            'window.testCaret.setSelection(25,25)'
        )

        p2 = multiprocessing.Process(
            target=self.type_text,
            args=(self.driver2, self.TEST_TEXT)
        )
        p2.start()
        p1.join()
        p2.join()

        # driver 2 goes online
        self.driver2.execute_script(
            'window.theApp.page.ws.goOnline()'
        )

        self.wait_for_doc_sync(self.driver, self.driver2)

        self.assertEqual(
            len(self.TEST_TEXT) * 2,
            len(self.get_contents(self.driver))
        )

        self.assertEqual(
            self.get_contents(self.driver2),
            self.get_contents(self.driver)
        )

        dialogtitle = WebDriverWait(self.driver2, self.wait_time).until(
            EC.element_to_be_clickable((By.CLASS_NAME, "ui-dialog-title"))
        )

        assert dialogtitle.text == 'System message'
        self.driver2.find_element_by_css_selector(
            '.ui-dialog button.fw-orange.fw-button'
        ).click()

        change_tracking_boxes = self.driver2.find_elements_by_css_selector(
            '.margin-box.track'
        )
        self.assertEqual(
            len(change_tracking_boxes),
            1
        )

        WebSocket.history_length = 1000

    def test_failed_authentication(self):
        """
        Test One Client Going offline, while the other client is still
        editing the document.The client who is offline has his/her
        session expired , while he/she is offline.
        When he/she comes back online , they see a dialog explaining the
        situation and the offline version of the document is downloaded.
        """
        self.load_document_editor(self.driver, self.doc)
        self.load_document_editor(self.driver2, self.doc)

        self.add_title(self.driver)
        self.driver.find_element_by_class_name(
            'article-body'
        ).click()

        p1 = multiprocessing.Process(
            target=self.type_text,
            args=(self.driver, self.TEST_TEXT)
        )
        p1.start()

        # Wait for the first processor to write some text
        self.wait_for_doc_size(self.driver2, 34)

        # driver 2 goes offline
        self.driver2.execute_script(
            'window.theApp.page.ws.goOffline()'
        )

        self.driver2.find_element_by_class_name(
            'article-body'
        ).click()

        # Total: 25
        self.driver2.execute_script(
            'window.testCaret.setSelection(25,25)'
        )

        p2 = multiprocessing.Process(
            target=self.type_text,
            args=(self.driver2, self.TEST_TEXT)
        )
        p2.start()
        p1.join()
        p2.join()

        # Clear cookie before coming back online
        self.driver2.delete_cookie(settings.SESSION_COOKIE_NAME)

        # driver 2 goes online
        self.driver2.execute_script(
            'window.theApp.page.ws.goOnline()'
        )

        # Check that session expiration dialog is displayed
        self.driver2.implicitly_wait(3)
        element = self.driver2.find_element_by_id('session_expiration_dialog')
        self.assertEqual(element.is_displayed(), True)

    def test_conflicting_changes(self):
        """
        Test One Client Going offline, while the other client is still
        editing the document.The client who is offline adds
        content to a paragraph. This paragraph is deleted by online user.
        Because of this conflict merge window opens up.
        """
        # The history length stored by the server is shortened from 1000 to 1.
        WebSocket.history_length = 1

        self.load_document_editor(self.driver, self.doc)
        self.load_document_editor(self.driver2, self.doc)

        self.add_title(self.driver)
        self.driver.find_element_by_class_name(
            'article-body'
        ).click()

        p1 = multiprocessing.Process(
            target=self.type_text,
            args=(self.driver, self.TEST_TEXT)
        )
        p1.start()

        # Wait for the first processor to write some text
        self.wait_for_doc_size(self.driver2, 34)

        # driver 2 goes offline
        self.driver2.execute_script(
            'window.theApp.page.ws.goOffline()'
        )

        self.driver2.find_element_by_class_name(
            'article-body'
        ).click()

        # Start writing text in the middle to cause conflict
        # when online user deletes data.
        self.driver2.execute_script(
            'window.testCaret.setSelection(27,27)'
        )

        p2 = multiprocessing.Process(
            target=self.type_text,
            args=(self.driver2, self.TEST_TEXT)
        )
        p2.start()
        p1.join()
        p2.join()

        # Delete all the content from client 1 to cause conflict.
        for i in range(0, len(self.TEST_TEXT)):
            actions = ActionChains(self.driver)
            actions.send_keys(Keys.BACKSPACE)
            actions.perform()

        # driver 2 goes online
        self.driver2.execute_script(
            'window.theApp.page.ws.goOnline()'
        )

        # Check whether the merge window is available in driver2
        self.driver2.implicitly_wait(3)
        element = self.driver2.find_element_by_id('editor-merge-view')
        self.assertEqual(element.is_displayed(), True)

        # Check that the documents in main editors are synced!
        self.assertEqual(
            self.get_contents(self.driver2),
            self.get_contents(self.driver)
        )

        # Change the websocket history length back to its original value
        WebSocket.history_length = 1000


class FunctionalOfflineTests(LiveTornadoTestCase, EditorHelper):
    """
    Tests in which one user works offline.The Service Worker is
    also installed in these tests.
    """
    user = None
    TEST_TEXT = "Lorem ipsum dolor sit amet."
    MULTILINE_TEST_TEXT = "Lorem ipsum\ndolor sit amet."
    fixtures = [
        'initial_documenttemplates.json',
        'initial_styles.json',
    ]

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        driver_data = cls.get_drivers(1)
        cls.driver = driver_data["drivers"][0]
        cls.client = driver_data["clients"][0]
        cls.wait_time = driver_data["wait_time"]

    @classmethod
    def tearDownClass(cls):
        cls.driver.quit()
        super().tearDownClass()

    def setUp(self):
        self.user = self.create_user()
        self.login_user(self.user, self.driver, self.client)
        self.driver.execute_script('window.theApp.installServiceWorker()')
        self.doc = self.create_new_document()

    def tearDown(self):
        self.leave_site(self.driver)

    def test_service_workers(self):
        """
        Test one client going offline after writing some text and inserting
        some images. While offline client tries to export to HTML
        and prints the PDF of the document.
        """
        self.load_document_editor(self.driver, self.doc)

        self.add_title(self.driver)
        self.driver.find_element_by_class_name(
            'article-body'
        ).click()

        self.type_text(self.driver, self.TEST_TEXT)

        # We add a figure
        button = self.driver.find_element_by_xpath('//*[@title="Figure"]')
        button.click()

        WebDriverWait(self.driver, self.wait_time).until(
            EC.presence_of_element_located((By.CLASS_NAME, "caption"))
        ).send_keys('Caption')
        self.driver.find_element_by_id("figure-category-btn").click()
        self.driver.find_element_by_id("figure-category-photo").click()

        # click on 'Insert image' button
        self.driver.find_element_by_id('insert-figure-image').click()

        upload_button = WebDriverWait(self.driver, self.wait_time).until(
            EC.presence_of_element_located(
                (
                    By.XPATH,
                    '//*[normalize-space()="Add new image"]'
                )
            )
        )
        upload_button.click()

        # image path
        image_path = os.path.join(
            settings.PROJECT_PATH,
            'document/tests/uploads/image.png'
        )

        # in order to select the image we send the image path in the
        # LOCAL MACHINE to the input tag
        upload_image_url = WebDriverWait(self.driver, self.wait_time).until(
            EC.presence_of_element_located(
                (By.XPATH, '//*[@id="editimage"]/div[1]/input[2]')
            )
        )
        upload_image_url.send_keys(image_path)

        # click on 'Upload' button
        self.driver.find_element_by_xpath(
            '//*[contains(@class, "ui-button") and normalize-space()="Upload"]'
        ).click()

        # click on 'Use image' button
        WebDriverWait(self.driver, self.wait_time).until(
            EC.element_to_be_clickable(
                (By.CSS_SELECTOR, '.fw-data-table i.fa-check')
            )
        )

        self.driver.find_element_by_xpath(
            '//*[normalize-space()="Use image"]'
        ).click()
        self.driver.find_element_by_css_selector("button.fw-dark").click()
        ActionChains(self.driver).send_keys(
            Keys.RIGHT
        ).perform()

        # driver goes offline
        self.driver.execute_script(
            'window.theApp.page.ws.goOffline()'
        )

        self.driver.implicitly_wait(5)

        # Check that the html export works fine!
        # Click on the menu
        self.driver.find_element_by_xpath(
            '//*[@id="header-navigation"]/div[2]/span'
        ).click()

        # Click on the HTML export
        self.driver.find_element_by_xpath(
            '//*[@id="header-navigation"]/div[2]/div/ul/li[1]/span'
        ).click()

        # Check that the alert box is displayed.
        self.driver.implicitly_wait(2)
        alert_element = self.driver.find_element_by_class_name('alerts-info')
        self.assertEqual(alert_element.is_displayed(), True)

        # Check the same for PDF export too !
        self.driver.implicitly_wait(5)

        # Click on the file menu
        self.driver.find_element_by_xpath(
            '//*[@id="header-navigation"]/div[1]/span'
        ).click()

        # Click on the Print PDF button
        self.driver.find_element_by_xpath(
            '//*[@id="header-navigation"]/div[1]/div/ul/li[7]/span'
        ).click()

        # Check that the alert box is displayed.
        self.driver.implicitly_wait(2)
        alert_element = self.driver.find_element_by_class_name('alerts-info')
        self.assertEqual(alert_element.is_displayed(), True)

    def test_disabled_options(self):
        """
        Test one client going offline after writing some text.
        While the client is offline tries different export
        options which are disabled. Tries to upload an image
        which is rejected.
        """
        self.load_document_editor(self.driver, self.doc)
        self.add_title(self.driver)

        # driver goes offline
        self.driver.execute_script(
            'window.theApp.page.ws.goOffline()'
        )
        self.driver.execute_script(
            'window.theApp.ws.goOffline()'
        )

        self.driver.find_element_by_class_name(
            'article-body'
        ).click()

        # Type some text
        self.type_text(self.driver, self.TEST_TEXT)

        # Check the share and create revision buttons are disabled.
        file_menu = self.driver.find_element_by_xpath(
            '//*[@id="header-navigation"]/div[1]/span'
        )
        file_menu.click()

        share_button = self.driver.find_element_by_xpath(
            '//*[@id="header-navigation"]/div[1]/div/ul/li[1]/span'
        )
        share_button_classes = share_button.get_attribute("class").split(' ')
        self.assertEqual('disabled' in share_button_classes, True)

        save_revision_button = self.driver.find_element_by_xpath(
            '//*[@id="header-navigation"]/div[1]/div/ul/li[3]/span'
        )
        save_revision_button_classes = save_revision_button.get_attribute(
            "class"
        ).split(' ')
        self.assertEqual('disabled' in save_revision_button_classes, True)

        # Check that the EPUB, LaTex and JATS exports are disabled
        # when user is offline.
        export_menu = self.driver.find_element_by_xpath(
            '//*[@id="header-navigation"]/div[2]/span'
        )
        export_menu.click()

        epub_export_button = self.driver.find_element_by_xpath(
            '//*[@id="header-navigation"]/div[2]/div/ul/li[2]/span'
        )
        epub_export_button_classes = epub_export_button.get_attribute(
            "class"
        ).split(' ')
        self.assertEqual('disabled' in epub_export_button_classes, True)

        latex_export_button = self.driver.find_element_by_xpath(
            '//*[@id="header-navigation"]/div[2]/div/ul/li[3]/span'
        )
        latex_export_button_classes = latex_export_button.get_attribute(
            "class"
        ).split(' ')
        self.assertEqual('disabled' in latex_export_button_classes, True)

        jats_export_button = self.driver.find_element_by_xpath(
            '//*[@id="header-navigation"]/div[2]/div/ul/li[4]/span'
        )
        jats_export_button_classes = jats_export_button.get_attribute(
            "class"
        ).split(' ')
        self.assertEqual('disabled' in jats_export_button_classes, True)

        # Check that the Switching between styles is disabled.
        settings_menu = self.driver.find_element_by_xpath(
            '//*[@id="header-navigation"]/div[3]/span'
        )
        settings_menu.click()

        doc_style_button = self.driver.find_element_by_xpath(
            '//*[@id="header-navigation"]/div[3]/div/ul/li[3]/span'
        )
        doc_style_button_classes = doc_style_button.get_attribute(
            "class"
        ).split(' ')
        self.assertEqual('disabled' in doc_style_button_classes, True)

        # Try to upload a figure
        button = self.driver.find_element_by_xpath('//*[@title="Figure"]')
        button.click()

        WebDriverWait(self.driver, self.wait_time).until(
            EC.presence_of_element_located((By.CLASS_NAME, "caption"))
        ).send_keys('Caption')
        self.driver.find_element_by_id("figure-category-btn").click()
        self.driver.find_element_by_id("figure-category-photo").click()

        # click on 'Insert image' button
        self.driver.find_element_by_id('insert-figure-image').click()

        upload_button = WebDriverWait(self.driver, self.wait_time).until(
            EC.presence_of_element_located(
                (
                    By.XPATH,
                    '//*[normalize-space()="Add new image"]'
                )
            )
        )

        upload_button.click()

        # image path
        image_path = os.path.join(
            settings.PROJECT_PATH,
            'document/tests/uploads/image.png'
        )

        # in order to select the image we send the image path in the
        # LOCAL MACHINE to the input tag
        upload_image_url = WebDriverWait(self.driver, self.wait_time).until(
            EC.presence_of_element_located(
                (By.XPATH, '//*[@id="editimage"]/div[1]/input[2]')
            )
        )
        upload_image_url.send_keys(image_path)

        # click on 'Upload' button
        self.driver.find_element_by_xpath(
            '//*[contains(@class, "ui-button") and normalize-space()="Upload"]'
        ).click()

        # Check that the image upload threw an error/alert.
        self.driver.implicitly_wait(2)
        alert_element = self.driver.find_element_by_class_name('alerts-error')
        self.assertEqual(alert_element.is_displayed(), True)
