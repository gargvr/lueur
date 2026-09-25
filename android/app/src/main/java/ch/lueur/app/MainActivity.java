package ch.lueur.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LueurHealthPlugin.class);
        super.onCreate(savedInstanceState);
        DailyWorker.Companion.schedule(this);
    }
}
