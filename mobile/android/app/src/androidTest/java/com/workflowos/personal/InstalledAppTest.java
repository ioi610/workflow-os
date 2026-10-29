package com.workflowos.personal;

import static org.junit.Assert.assertEquals;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Installation check; run on a device or emulator with connectedAndroidTest. */
@RunWith(AndroidJUnit4.class)
public class InstalledAppTest {
    @Test
    public void installedPackageIsWorkflowOs() {
        Context installed = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("com.workflowos.personal", installed.getPackageName());
    }
}
